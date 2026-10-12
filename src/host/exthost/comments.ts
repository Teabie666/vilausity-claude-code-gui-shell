/**
 * Comments on text selected in the content pane. They belong to a conversation's session
 * until the next message the user sends there, which carries them (bridge.ts): closing the
 * conversation keeps them, and they show again wherever the session is opened next. A new
 * conversation's session only counts once it has a transcript (bridge.ts); until then its
 * comments wait on its panel and go to the session after that. The renderer adds, edits and
 * removes them by webview and is told of every change. Sessions' comments are kept in
 * workspace storage; those still waiting on a panel come back with it after a restart
 * (panelRestore.ts).
 */

import * as path from 'node:path';
import type { StorageBackend } from '../../compat/vscode/host';
import { flattenQuote, isComment, linesLabel } from '../../platform/comments';
import { Emitter, type Event } from '../../platform/event';
import type { IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { CommentDto } from '../../platform/protocol';
import type { RendererRpc } from './compatHost';

/** Opens the block of comments a message carries. */
export const COMMENTS_HEADER = 'Comments on selected text:';

/** A quote in a message is cut here; the file and lines locate the rest. */
const MESSAGE_QUOTE_LIMIT = 200;

/** Workspace storage: `{ <session id>: CommentDto[] }`. */
const STORAGE_KEY = 'vilaus.comments';

/** Keys in the store: a session's comments, or those of a panel that has no session yet. */
const SESSION_KEY = 'session:';
const PANEL_KEY = 'webview:';

export class CommentStore {
  private readonly byKey = new Map<string, readonly CommentDto[]>();
  private readonly changeEmitter = new Emitter<string>();
  /** Fires the key whose comments changed. */
  readonly onDidChange: Event<string> = this.changeEmitter.event;

  /** Oldest first. */
  list(key: string): readonly CommentDto[] {
    return this.byKey.get(key) ?? [];
  }

  /** Every key that has comments. */
  keys(): string[] {
    return [...this.byKey.keys()];
  }

  /** Appends the comments whose ids are new here. Returns whether any were. */
  add(key: string, ...comments: CommentDto[]): boolean {
    const existing = this.list(key);
    const ids = new Set(existing.map((comment) => comment.id));
    const added: CommentDto[] = [];
    for (const comment of comments) {
      if (!ids.has(comment.id)) {
        ids.add(comment.id);
        added.push(comment);
      }
    }
    if (added.length > 0) {
      this.set(key, [...existing, ...added]);
    }
    return added.length > 0;
  }

  update(key: string, id: string, text: string): void {
    const comments = this.list(key);
    if (comments.some((comment) => comment.id === id && comment.text !== text)) {
      this.set(
        key,
        comments.map((comment) => (comment.id === id ? { ...comment, text } : comment)),
      );
    }
  }

  remove(key: string, ids: readonly string[]): void {
    const comments = this.list(key);
    const kept = comments.filter((comment) => !ids.includes(comment.id));
    if (kept.length !== comments.length) {
      this.set(key, kept);
    }
  }

  /** Replaces the comments under a key. */
  set(key: string, comments: readonly CommentDto[]): void {
    if (comments.length === 0 && !this.byKey.has(key)) {
      return;
    }
    if (comments.length === 0) {
      this.byKey.delete(key);
    } else {
      this.byKey.set(key, comments);
    }
    this.changeEmitter.fire(key);
  }

  /** Removes the comments under a key and returns them: a message took them along. */
  take(key: string): readonly CommentDto[] {
    const comments = this.list(key);
    this.set(key, []);
    return comments;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** A conversation's comments by the webview of its panel, as a message takes them along. */
export interface PendingComments {
  list(webviewId: string): readonly CommentDto[];
  take(webviewId: string): readonly CommentDto[];
}

/** What the comments need of the open conversation panels (WebviewManager). */
export interface CommentPanels {
  readonly allPanels: readonly { readonly webview: { readonly id: string; readonly state: unknown } }[];
  /** A panel was created or disposed, or a panel's webview state changed. */
  readonly onDidChangePanels: Event<void>;
}

/**
 * The comments of every conversation, kept by session and served by the webview of the
 * panel that shows it now. A panel follows its page: when the page moves to another session,
 * the panel shows that session's comments.
 */
export class ConversationComments implements PendingComments, IDisposable {
  private readonly store = new CommentStore();
  /** Each open panel's store key, by webview id. */
  private readonly keys = new Map<string, string>();
  private readonly changeEmitter = new Emitter<string>();
  /** Fires the webview id of a panel whose comments changed, or that shows another session's now. */
  readonly onDidChange: Event<string> = this.changeEmitter.event;
  private readonly subscriptions: IDisposable[];

  constructor(
    private readonly panels: CommentPanels,
    /** The session a panel's page shows, from the state it saved (bridge.ts). */
    private readonly sessionIdOf: (state: unknown) => string | undefined,
    private readonly storage: StorageBackend,
  ) {
    const saved = storage.initial('workspace')[STORAGE_KEY];
    if (typeof saved === 'object' && saved !== null && !Array.isArray(saved)) {
      for (const [sessionId, comments] of Object.entries(saved)) {
        this.store.set(SESSION_KEY + sessionId, sanitizeComments(comments));
      }
    }
    this.subscriptions = [this.store.onDidChange((key) => this.storeChanged(key)), panels.onDidChangePanels(() => this.followAll())];
    this.followAll();
  }

  /** Oldest first; none for a webview that is no panel. */
  list(webviewId: string): readonly CommentDto[] {
    const key = this.keyOf(webviewId);
    return key ? this.store.list(key) : [];
  }

  /** Returns false when the webview is no panel (any more). */
  add(webviewId: string, comment: CommentDto): boolean {
    const key = this.keyOf(webviewId);
    if (key) {
      this.store.add(key, comment);
    }
    return key !== undefined;
  }

  update(webviewId: string, id: string, text: string): void {
    const key = this.keyOf(webviewId);
    if (key) {
      this.store.update(key, id, text);
    }
  }

  remove(webviewId: string, ids: readonly string[]): void {
    const key = this.keyOf(webviewId);
    if (key) {
      this.store.remove(key, ids);
    }
  }

  take(webviewId: string): readonly CommentDto[] {
    const key = this.keyOf(webviewId);
    return key ? this.store.take(key) : [];
  }

  /** The comments a panel keeps itself, to be saved with it: those not in a session yet. */
  unsessioned(webviewId: string): readonly CommentDto[] {
    const key = this.keyOf(webviewId);
    return key?.startsWith(PANEL_KEY) ? this.store.list(key) : [];
  }

  /** Comments saved with a panel, back after a restart (in its session, when its state names one). */
  restore(webviewId: string, comments: readonly CommentDto[]): void {
    const key = this.keyOf(webviewId);
    if (key) {
      this.store.add(key, ...comments);
    }
  }

  dispose(): void {
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.store.dispose();
    this.changeEmitter.dispose();
  }

  /**
   * A panel's key as its page's state says now. Webview state can be set without an event
   * (a restored panel's), so every use looks again rather than trusting the last event.
   */
  private keyOf(webviewId: string): string | undefined {
    const panel = this.panels.allPanels.find((candidate) => candidate.webview.id === webviewId);
    if (!panel) {
      return undefined;
    }
    this.follow(webviewId, this.keyFor(panel.webview));
    return this.keys.get(webviewId);
  }

  private keyFor(webview: { readonly id: string; readonly state: unknown }): string {
    const sessionId = this.sessionIdOf(webview.state);
    return sessionId ? SESSION_KEY + sessionId : PANEL_KEY + webview.id;
  }

  /** Points every open panel at its page's session; the closed ones' comments stay with their sessions. */
  private followAll(): void {
    const open = new Set<string>();
    for (const panel of this.panels.allPanels) {
      open.add(panel.webview.id);
      this.follow(panel.webview.id, this.keyFor(panel.webview));
    }
    for (const [webviewId, key] of [...this.keys]) {
      if (!open.has(webviewId)) {
        this.keys.delete(webviewId);
        // Without a session nothing can show them again.
        if (key.startsWith(PANEL_KEY)) {
          this.store.set(key, []);
        }
      }
    }
  }

  private follow(webviewId: string, key: string): void {
    const previous = this.keys.get(webviewId);
    if (previous === key) {
      return;
    }
    this.keys.set(webviewId, key);
    // What a new conversation collected goes to the session it gets (the panel key is its alone).
    const waiting = previous?.startsWith(PANEL_KEY) ? this.store.take(previous) : [];
    const moved = this.store.add(key, ...waiting);
    // When nothing moved, the store said nothing, but the panel now shows other comments.
    if (!moved && (previous !== undefined || this.store.list(key).length > 0)) {
      this.changeEmitter.fire(webviewId);
    }
  }

  private storeChanged(key: string): void {
    if (key.startsWith(SESSION_KEY)) {
      const sessions: Record<string, readonly CommentDto[]> = {};
      for (const sessionKey of this.store.keys().filter((candidate) => candidate.startsWith(SESSION_KEY))) {
        sessions[sessionKey.slice(SESSION_KEY.length)] = this.store.list(sessionKey);
      }
      this.storage.set('workspace', STORAGE_KEY, sessions);
    }
    for (const [webviewId, panelKey] of this.keys) {
      if (panelKey === key) {
        this.changeEmitter.fire(webviewId);
      }
    }
  }
}

/** The well-formed comments in a stored value (anything else is dropped). */
export function sanitizeComments(value: unknown): CommentDto[] {
  return Array.isArray(value) ? value.filter(isComment) : [];
}

/** Relative to the workspace folder it is in (with `/` separators), else the whole path. */
export function displayPath(file: string, workspaceFolders: readonly string[]): string {
  for (const folder of workspaceFolders) {
    const relative = path.relative(folder, file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/');
    }
  }
  return file;
}

/**
 * The text a message carries for its comments, oldest first, one paragraph each, in the
 * extension's plan-comment style with the place added: `[Re: "<quote>" — <file>:<lines>] <comment>`.
 */
export function formatComments(comments: readonly CommentDto[], workspaceFolders: readonly string[]): string {
  const paragraphs = comments.map((comment) => {
    const quote = flattenQuote(comment.quote, MESSAGE_QUOTE_LIMIT);
    const place = `${displayPath(comment.path, workspaceFolders)}:${linesLabel(comment.range)}`;
    return `[Re: "${quote}" — ${place}] ${comment.text.trim()}`;
  });
  return `${COMMENTS_HEADER}\n\n${paragraphs.join('\n\n')}`;
}

/**
 * Serves the renderer's comment requests and tells it about every change. Requests for a
 * webview that is no conversation (any more) are ignored.
 */
export function registerCommentRequests(renderer: RendererRpc, comments: ConversationComments, logger: ILogger): IDisposable {
  renderer.handle('comments.add', ({ webviewId, comment }) => {
    if (!isComment(comment) || !comments.add(webviewId, comment)) {
      logger.warn(`ignored a comment for ${webviewId}`);
    }
  });
  renderer.handle('comments.update', ({ webviewId, id, text }) => comments.update(webviewId, id, text));
  renderer.handle('comments.remove', ({ webviewId, ids }) => comments.remove(webviewId, ids));
  return comments.onDidChange((webviewId) => renderer.notify('comments.didChange', { webviewId, comments: comments.list(webviewId) }));
}
