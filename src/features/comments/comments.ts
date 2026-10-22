/**
 * Comments on selected text, per conversation. The extension host keeps them (the bridge
 * sends them with the next message); this mirrors them, shows them as blocks above each
 * conversation's input (or in a bar of the shell's when the page has no place for them),
 * and runs the form that adds and edits them. The text can be in the content pane or in the
 * conversation itself, whose page offers a Comment button for it and highlights it.
 */

import { URI } from 'vscode-uri';
import type { EditorSelectionContext } from '../../core/editors';
import type { ExtensionHostConnection } from '../../core/extensionHost';
import type { Layout } from '../../core/layout';
import type { WebviewFrames } from '../../core/webviewFrames';
import { Emitter, type Event } from '../../platform/event';
import { generateId } from '../../platform/ids';
import { DisposableStore, type IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { CommentDto, CommentsHostEvent, ConversationSelectionDto, FileCommentDto, RectDto } from '../../platform/protocol';
import type { ContentPane } from '../contentPane/contentPane';
import type { ConversationTabs } from '../conversations/conversationTabs';
import { CommentForm } from './commentForm';
import { CommentsFallbackBar } from './fallbackBar';
import { commentSource, commentsView, conversationSource, sourceLabel } from './view';

/** How long the blocks may lack a place in the page before the shell shows them itself. */
const FALLBACK_DELAY_MS = 1500;
/** How long a page may take to say what is selected in it (ms). */
const SELECTION_TIMEOUT_MS = 1000;
/** The form's width where it opens by a selection (its CSS width). */
const FORM_WIDTH = 360;

interface ConversationState {
  comments: readonly CommentDto[];
  /** What the page last reported; undefined until it has shown blocks since it loaded. */
  attached: boolean | undefined;
  fallback: CommentsFallbackBar | undefined;
  fallbackTimer: ReturnType<typeof setTimeout> | undefined;
}

export class CommentsController implements IDisposable {
  private readonly states = new Map<string, ConversationState>();
  private readonly disposables = new DisposableStore();
  /** The open form (at most one) and how to take it down. */
  private form: { form: CommentForm; close: () => void } | undefined;
  private readonly changeEmitter = new Emitter<void>();
  /** The active conversation's comments changed, or another conversation became the active one. */
  readonly onDidChange: Event<void> = this.changeEmitter.event;
  /** The webview that has the keyboard focus, if any. */
  private focusedWebview: string | undefined;
  /** Asking a page for its selection: the request's id and what takes the answer. */
  private selectionRequest: { id: number; answer: (selection: ConversationSelectionDto | null) => void } | undefined;
  private nextRequestId = 1;

  constructor(
    private readonly connection: ExtensionHostConnection,
    private readonly frames: WebviewFrames,
    private readonly conversations: ConversationTabs,
    private readonly contentPane: ContentPane,
    private readonly layout: Layout,
    private readonly logger: ILogger,
  ) {
    this.disposables.add(
      connection.onDidConnect((rpc) => {
        rpc.handle('comments.didChange', ({ webviewId, comments }) => this.didChange(webviewId, comments));
      }),
    );
    // The page starts over: it needs the blocks again, and will say again whether they fit.
    this.disposables.add(
      frames.onDidLoad(({ webviewId }) => {
        const state = this.states.get(webviewId);
        if (state) {
          state.attached = undefined;
          this.frames.setComments(webviewId, commentsView(state.comments));
          this.updateFallback(webviewId);
        }
      }),
    );
    this.disposables.add(
      frames.onDidCommentsEvent(({ webviewId, event }) => this.onHostEvent(webviewId, event, this.frameOrigin(webviewId))),
    );
    this.disposables.add(frames.onDidDispose(({ webviewId }) => this.forget(webviewId)));
    this.disposables.add(conversations.onDidChangeActive(() => this.changeEmitter.fire()));
    this.disposables.add(
      frames.onDidChangeFocus(({ webviewId, focused }) => {
        if (focused) {
          this.focusedWebview = webviewId;
        } else if (this.focusedWebview === webviewId) {
          this.focusedWebview = undefined;
        }
      }),
    );
  }

  /** The active conversation's comments, oldest first. */
  get activeComments(): readonly CommentDto[] {
    const webviewId = this.conversations.active?.webviewId;
    return (webviewId && this.states.get(webviewId)?.comments) || [];
  }

  /** Opens the form next to a selection; the comment goes to the conversation shown now. */
  add(context: EditorSelectionContext): void {
    const conversation = this.conversations.active;
    if (!conversation) {
      return;
    }
    const { selection } = context;
    let widget: IDisposable | undefined;
    const form = new CommentForm({
      quote: selection.text,
      source: sourceLabel(selection.path, selection.range),
      onSubmit: (text) => {
        // The conversation it was opened for, unless that one is gone meanwhile.
        const target = this.conversations.ordered.some((panel) => panel.webviewId === conversation.webviewId)
          ? conversation.webviewId
          : this.conversations.active?.webviewId;
        if (target) {
          const comment: FileCommentDto = {
            kind: 'file',
            id: generateId('comment-'),
            quote: selection.text,
            uri: selection.uri,
            path: selection.path,
            range: selection.range,
            text,
          };
          this.connection.rpc?.notify('comments.add', { webviewId: target, comment });
        }
        this.closeForm();
      },
      onCancel: () => this.closeForm(),
    });
    this.openForm(form, () => widget?.dispose());
    widget = context.showWidget(form.element);
    form.focus();
  }

  /**
   * With the keyboard focus in a conversation, comments on the text selected there: opens the
   * form by it. Returns false when the focus is elsewhere or nothing is selected there.
   */
  async addInFocusedConversation(): Promise<boolean> {
    const webviewId = this.focusedWebview;
    if (!webviewId || !this.conversations.ordered.some((panel) => panel.webviewId === webviewId)) {
      return false;
    }
    const id = this.nextRequestId++;
    const selection = await new Promise<ConversationSelectionDto | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), SELECTION_TIMEOUT_MS);
      this.selectionRequest = {
        id,
        answer: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
      };
      this.frames.requestCommentSelection(webviewId, id);
    });
    if (this.selectionRequest?.id === id) {
      this.selectionRequest = undefined;
    }
    if (!selection) {
      return false;
    }
    this.addInConversation(webviewId, selection);
    return true;
  }

  /** Opens the form by text selected in a conversation; the comment goes to that conversation. */
  private addInConversation(webviewId: string, selection: ConversationSelectionDto): void {
    const form = new CommentForm({
      quote: selection.quote,
      source: conversationSource(selection.place.role),
      onSubmit: (text) => {
        this.connection.rpc?.notify('comments.add', {
          webviewId,
          comment: { kind: 'conversation', id: generateId('comment-'), quote: selection.quote, place: selection.place, text },
        });
        this.closeForm();
      },
      onCancel: () => this.closeForm(),
    });
    // Below the end of the selection (above it when there is no room), like in the editor.
    const origin = this.frameOrigin(webviewId);
    const { rect } = selection;
    this.openOverlay(form, FORM_WIDTH, {
      left: origin.left + rect.left + rect.width,
      top: origin.top + rect.top + rect.height + 4,
      above: origin.top + rect.top - 4,
    });
  }

  /** Removes every comment of the active conversation. */
  clearActive(): void {
    const webviewId = this.conversations.active?.webviewId;
    const comments = webviewId ? this.states.get(webviewId)?.comments : undefined;
    if (webviewId && comments?.length) {
      this.connection.rpc?.notify('comments.remove', { webviewId, ids: comments.map((comment) => comment.id) });
    }
  }

  dispose(): void {
    this.closeForm();
    for (const webviewId of [...this.states.keys()]) {
      this.forget(webviewId);
    }
    this.disposables.dispose();
    this.changeEmitter.dispose();
  }

  private didChange(webviewId: string, comments: readonly CommentDto[]): void {
    let state = this.states.get(webviewId);
    if (!state) {
      if (comments.length === 0) {
        return;
      }
      state = { comments, attached: undefined, fallback: undefined, fallbackTimer: undefined };
      this.states.set(webviewId, state);
    }
    state.comments = comments;
    const view = commentsView(comments);
    this.frames.setComments(webviewId, view);
    state.fallback?.update(view);
    this.updateFallback(webviewId);
    if (webviewId === this.conversations.active?.webviewId) {
      this.changeEmitter.fire();
    }
  }

  private forget(webviewId: string): void {
    const state = this.states.get(webviewId);
    if (state) {
      clearTimeout(state.fallbackTimer);
      state.fallback?.dispose();
      this.states.delete(webviewId);
    }
  }

  /**
   * The shell's bar shows while there are comments the page has not placed: at once when
   * the page said it has no place, after a while when it said nothing yet.
   */
  private updateFallback(webviewId: string): void {
    const state = this.states.get(webviewId);
    if (!state) {
      return;
    }
    clearTimeout(state.fallbackTimer);
    const needed = state.comments.length > 0 && state.attached !== true;
    if (!needed) {
      if (state.fallback) {
        state.fallback.visible = false;
      }
      return;
    }
    state.fallbackTimer = setTimeout(() => {
      if (state.comments.length === 0 || state.attached === true) {
        return;
      }
      const bar = this.fallbackBar(webviewId, state);
      if (bar) {
        bar.update(commentsView(state.comments));
        bar.visible = true;
        this.logger.warn(`comment blocks found no place in webview ${webviewId}; showing them below it`);
      }
    }, FALLBACK_DELAY_MS);
  }

  private fallbackBar(webviewId: string, state: ConversationState): CommentsFallbackBar | undefined {
    if (state.fallback) {
      return state.fallback;
    }
    const panel = this.conversations.ordered.find((candidate) => candidate.webviewId === webviewId);
    if (!panel) {
      return undefined;
    }
    const bar = new CommentsFallbackBar((event) => this.onHostEvent(webviewId, event, { left: 0, top: 0 }));
    panel.container.appendChild(bar.element);
    state.fallback = bar;
    return bar;
  }

  /** Where a webview's viewport sits in the window, to place shell UI over its page. */
  private frameOrigin(webviewId: string): { left: number; top: number } {
    const rect = this.frames.element(webviewId)?.getBoundingClientRect();
    return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
  }

  private onHostEvent(webviewId: string, event: CommentsHostEvent, origin: { left: number; top: number }): void {
    const state = this.states.get(webviewId);
    const comment = 'id' in event ? state?.comments.find((candidate) => candidate.id === event.id) : undefined;
    switch (event.type) {
      case 'attached':
        if (state) {
          state.attached = event.attached;
          this.updateFallback(webviewId);
        }
        break;
      case 'remove':
        this.connection.rpc?.notify('comments.remove', { webviewId, ids: [event.id] });
        break;
      case 'clear':
        if (state) {
          this.connection.rpc?.notify('comments.remove', { webviewId, ids: state.comments.map((candidate) => candidate.id) });
        }
        break;
      case 'edit':
        if (comment) {
          this.edit(webviewId, comment, {
            left: origin.left + event.rect.left,
            top: origin.top + event.rect.top,
            width: event.rect.width,
            height: event.rect.height,
          });
        }
        break;
      case 'reveal':
        if (comment?.kind === 'conversation') {
          this.frames.revealQuote(webviewId, { quote: comment.quote, place: comment.place });
        } else if (comment) {
          void this.reveal(comment).catch((error: unknown) => this.logger.warn(`cannot show ${comment.uri}`, error));
        }
        break;
      case 'selection':
        if (event.id !== undefined) {
          if (event.id === this.selectionRequest?.id) {
            this.selectionRequest.answer(event.selection);
          }
        } else if (event.selection && this.conversations.ordered.some((panel) => panel.webviewId === webviewId)) {
          this.addInConversation(webviewId, event.selection);
        }
        break;
    }
  }

  /** Edits a comment in a form over its block (`at`: the block, in window coordinates). */
  private edit(webviewId: string, comment: CommentDto, at: RectDto): void {
    const form = new CommentForm({
      quote: comment.quote,
      source: commentSource(comment),
      text: comment.text,
      onSubmit: (text) => {
        this.connection.rpc?.notify('comments.update', { webviewId, id: comment.id, text });
        this.closeForm();
      },
      onCancel: () => this.closeForm(),
    });
    // Over the block, as wide as it (or wider).
    this.openOverlay(form, Math.max(at.width, 320), { left: at.left, top: at.top });
  }

  /**
   * Shows the form over the window at `at` (window coordinates), kept inside the window: above
   * `at.above` instead when given and there is no room below `at.top`.
   */
  private openOverlay(form: CommentForm, width: number, at: { left: number; top: number; above?: number }): void {
    const overlay = document.createElement('div');
    overlay.className = 'comment-form-overlay';
    overlay.appendChild(form.element);
    this.openForm(form, () => overlay.remove());
    this.layout.overlays.appendChild(overlay);
    overlay.style.width = `${width}px`;
    overlay.style.left = `${Math.max(4, Math.min(at.left, window.innerWidth - width - 4))}px`;
    const height = overlay.offsetHeight;
    const top = at.above !== undefined && at.top + height > window.innerHeight - 4 ? at.above - height : at.top;
    overlay.style.top = `${Math.max(4, Math.min(top, window.innerHeight - height - 4))}px`;
    form.focus();
  }

  private openForm(form: CommentForm, remove: () => void): void {
    this.closeForm();
    const doc = (): Document => form.element.ownerDocument;
    // Clicking elsewhere closes it, unless that would lose what was typed.
    const onPointerDown = (event: MouseEvent): void => {
      if (!form.element.contains(event.target as Node) && !form.isDirty) {
        this.closeForm();
      }
    };
    // A click into a page (an iframe) is no mousedown here: the window loses the focus to it.
    const onBlur = (event: FocusEvent): void => {
      const target = event.target as Window;
      if (target.document.activeElement instanceof HTMLIFrameElement && !form.isDirty) {
        this.closeForm();
      }
    };
    // The form may live in another window (a tab moved out of the main one): listen there.
    const listenOn = new Set([document]);
    queueMicrotask(() => {
      listenOn.add(doc());
      for (const target of listenOn) {
        target.addEventListener('mousedown', onPointerDown, true);
        target.defaultView?.addEventListener('blur', onBlur);
      }
    });
    this.form = {
      form,
      close: () => {
        for (const target of listenOn) {
          target.removeEventListener('mousedown', onPointerDown, true);
          target.defaultView?.removeEventListener('blur', onBlur);
        }
        remove();
      },
    };
  }

  private closeForm(): void {
    const open = this.form;
    this.form = undefined;
    open?.close();
  }

  /** Shows the commented text: in the tab that shows its document, else by opening it. */
  private async reveal(comment: FileCommentDto): Promise<void> {
    const open = this.contentPane.tabs.find((tab) => tab.input.resource === comment.uri && tab.pane.revealSelection !== undefined);
    if (open) {
      this.contentPane.open(open.input);
      open.pane.revealSelection?.(comment.uri, comment.range, comment.quote);
      return;
    }
    // Not open (or the diff it was on is gone): the file itself.
    const uri = comment.uri.startsWith('file:') ? comment.uri : URI.file(comment.path).toString();
    const shown = await this.connection.rpc?.call('documents.show', { uri, preserveFocus: false, preview: true, selection: comment.range });
    if (shown) {
      const tab = this.contentPane.tabs.find((candidate) => candidate.input.resource === uri);
      tab?.pane.revealSelection?.(uri, comment.range, comment.quote);
    }
  }
}
