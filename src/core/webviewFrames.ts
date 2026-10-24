/**
 * One sandboxed <iframe> per extension webview. Routes messages both ways:
 * extension -> iframe (queued until the document has loaded, as VS Code does) and
 * iframe -> extension host / shell (validated by the sending window).
 */

import { Emitter, type Event } from '../platform/event';
import { toDisposable, type IDisposable } from '../platform/lifecycle';
import type { ILogger } from '../platform/log';
import type {
  CommentsHostEvent,
  CommentsViewDto,
  ConversationQuoteDto,
  ExtensionTranslations,
  FindDirection,
  KeyEventDto,
  ShellToWebviewControl,
  ThemeData,
  WebviewToShellMessage,
} from '../platform/protocol';
import type { ExtensionHostConnection } from './extensionHost';
import { native } from './native';

const SANDBOX = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-pointer-lock',
  'allow-downloads',
  // window.open is allowed only so main's window-open handler can route it to the browser.
  'allow-popups',
].join(' ');

export interface WebviewKeyEvent {
  readonly webviewId: string;
  readonly event: KeyEventDto;
}

/** A file link's message a page holds back for the shell (pages with `hints.fileLinks`); answer with `answerFileLink`. */
export interface FileLinkRequest {
  readonly webviewId: string;
  readonly id: number;
  /** As the page has it: maybe relative to the workspace. */
  readonly path: string;
  /** Shift+clicked: open it with its program; right-clicked: the menu. */
  readonly intent: 'system' | 'menu';
  /** A Markdown link's href. */
  readonly link: string | undefined;
}

/** Files dragged over a webview's page (`end`: the drag ended otherwise); `x`, `y` in the page's viewport. */
export interface WebviewFileDrag {
  readonly webviewId: string;
  readonly phase: 'over' | 'leave' | 'drop' | 'end';
  readonly x: number;
  readonly y: number;
}

export interface WebviewInfo {
  readonly webviewId: string;
  /** The panel's viewType or the view's id; VS Code's `webviewId` context key. */
  readonly viewType: string;
}

class WebviewFrame {
  iframe: HTMLIFrameElement;
  private loaded = false;
  private loadedOnce = false;
  private queue: unknown[] = [];
  private origin = '*';
  private url: string | undefined;

  constructor(
    readonly webviewId: string,
    readonly viewType: string,
    container: HTMLElement,
    private readonly title: string,
    private readonly onLoad: () => void,
  ) {
    this.iframe = this.createIframe(container);
  }

  get contentWindow(): Window | null {
    return this.iframe.contentWindow;
  }

  load(url: string): void {
    this.loaded = false;
    if (this.loadedOnce) {
      // Messages meant for the previous document are dropped, like VS Code does.
      this.queue = [];
    }
    this.url = url;
    this.origin = new URL(url).origin;
    this.iframe.src = url;
  }

  /**
   * Shows the webview in another container, possibly in another window. An iframe that
   * moves reloads anyway, so this makes a new one on the same document; the page starts
   * over (with its last saved state), as when VS Code moves a webview.
   */
  relocate(container: HTMLElement): void {
    const previous = this.iframe;
    this.iframe = this.createIframe(container);
    previous.remove();
    if (this.url) {
      this.load(this.url);
    }
  }

  private createIframe(container: HTMLElement): HTMLIFrameElement {
    const iframe = container.ownerDocument.createElement('iframe');
    iframe.className = 'webview-frame';
    iframe.title = this.title;
    iframe.setAttribute('sandbox', SANDBOX);
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write; autoplay');
    iframe.addEventListener('load', () => {
      if (!iframe.src || iframe !== this.iframe) {
        return;
      }
      this.loaded = true;
      this.loadedOnce = true;
      const pending = this.queue;
      this.queue = [];
      for (const message of pending) {
        this.deliver(message);
      }
      this.onLoad();
    });
    container.appendChild(iframe);
    return iframe;
  }

  post(message: unknown): void {
    if (this.loaded) {
      this.deliver(message);
    } else {
      this.queue.push(message);
    }
  }

  focus(): void {
    this.iframe.contentWindow?.focus();
  }

  dispose(): void {
    this.queue = [];
    this.iframe.remove();
  }

  private deliver(message: unknown): void {
    this.iframe.contentWindow?.postMessage(message, this.origin === 'null' ? '*' : this.origin);
  }
}

export class WebviewFrames {
  private readonly frames = new Map<string, WebviewFrame>();
  private readonly keyEmitter = new Emitter<WebviewKeyEvent>();
  readonly onDidKeyDown: Event<WebviewKeyEvent> = this.keyEmitter.event;
  private readonly focusEmitter = new Emitter<{ webviewId: string; focused: boolean }>();
  readonly onDidChangeFocus = this.focusEmitter.event;
  private readonly findEmitter = new Emitter<{ webviewId: string; matches: number; active: number }>();
  /** Answers to find: match count and the 1-based active match (0 when none). */
  readonly onDidFindResult = this.findEmitter.event;
  private readonly createEmitter = new Emitter<WebviewInfo>();
  readonly onDidCreate: Event<WebviewInfo> = this.createEmitter.event;
  private readonly disposeEmitter = new Emitter<WebviewInfo>();
  readonly onDidDispose: Event<WebviewInfo> = this.disposeEmitter.event;
  private readonly loadEmitter = new Emitter<WebviewInfo>();
  /** A webview's document loaded: a new page, which knows nothing the shell told the previous one. */
  readonly onDidLoad: Event<WebviewInfo> = this.loadEmitter.event;
  private readonly commentsEmitter = new Emitter<{ webviewId: string; event: CommentsHostEvent }>();
  /** What the comment blocks in a webview report (see `setComments`). */
  readonly onDidCommentsEvent = this.commentsEmitter.event;
  private readonly deleteSessionEmitter = new Emitter<{ sessionId: string; title: string }>();
  /** The delete button of a session list's row was clicked (pages with `hints.sessionRows`). */
  readonly onDidRequestSessionDelete = this.deleteSessionEmitter.event;
  private readonly providerFilterEmitter = new Emitter<void>();
  /** The session list's "this API only" toggle was clicked (pages with `hints.sessionRows`). */
  readonly onDidToggleProviderFilter: Event<void> = this.providerFilterEmitter.event;
  private readonly switchProviderEmitter = new Emitter<{ providerId: string; sessionId: string }>();
  /** A conversation's provider notice asks to switch the window to the provider it ran under and reopen it. */
  readonly onDidRequestProviderSwitch: Event<{ providerId: string; sessionId: string }> = this.switchProviderEmitter.event;
  private readonly editPricesEmitter = new Emitter<void>();
  /** The usage block's link to the provider's prices was clicked (pages with `hints.usageBlock`). */
  readonly onDidRequestEditPrices: Event<void> = this.editPricesEmitter.event;
  private readonly fullTranscriptEmitter = new Emitter<string>();
  /** A conversation page's link to its full transcript was clicked: the webview's id. */
  readonly onDidRequestFullTranscript: Event<string> = this.fullTranscriptEmitter.event;
  private readonly navigateEmitter = new Emitter<'back' | 'forward'>();
  /** The mouse's back or forward button was released over a webview. */
  readonly onDidRequestNavigate: Event<'back' | 'forward'> = this.navigateEmitter.event;
  private readonly fileLinkEmitter = new Emitter<FileLinkRequest>();
  /** A file link was Shift+clicked or right-clicked (pages with `hints.fileLinks`). */
  readonly onDidRequestFileLink: Event<FileLinkRequest> = this.fileLinkEmitter.event;
  private readonly fileDragEmitter = new Emitter<WebviewFileDrag>();
  /** Files are dragged over a webview, left it or were dropped on it (which the page takes itself). */
  readonly onDidDragFiles: Event<WebviewFileDrag> = this.fileDragEmitter.event;

  constructor(
    private readonly connection: ExtensionHostConnection,
    private readonly logger: ILogger,
  ) {
    window.addEventListener('message', (event) => this.onWindowMessage(event));
  }

  /** Webviews shown in another window post to that window; listen there too. */
  watchWindow(target: Window): IDisposable {
    const listener = (event: MessageEvent): void => this.onWindowMessage(event, target);
    target.addEventListener('message', listener);
    return toDisposable(() => target.removeEventListener('message', listener));
  }

  /** Moves a webview to another container (e.g. into an auxiliary window); its page reloads. */
  relocate(webviewId: string, container: HTMLElement): void {
    this.get(webviewId)?.relocate(container);
  }

  create(webviewId: string, viewType: string, container: HTMLElement, title: string): void {
    if (this.frames.has(webviewId)) {
      this.logger.warn(`webview ${webviewId} created twice`);
      return;
    }
    const frame = new WebviewFrame(webviewId, viewType, container, title, () => {
      this.connection.rpc?.notify('webview.didLoad', { webviewId });
      this.loadEmitter.fire({ webviewId, viewType });
    });
    this.frames.set(webviewId, frame);
    this.createEmitter.fire({ webviewId, viewType });
  }

  get all(): WebviewInfo[] {
    return [...this.frames.values()].map(({ webviewId, viewType }) => ({ webviewId, viewType }));
  }

  viewTypeOf(webviewId: string): string | undefined {
    return this.frames.get(webviewId)?.viewType;
  }

  load(webviewId: string, url: string): void {
    this.get(webviewId)?.load(url);
  }

  post(webviewId: string, message: unknown): void {
    this.get(webviewId)?.post(message);
  }

  focus(webviewId: string): void {
    this.get(webviewId)?.focus();
  }

  dispose(webviewId: string): void {
    const frame = this.frames.get(webviewId);
    if (!frame) {
      return;
    }
    frame.dispose();
    this.frames.delete(webviewId);
    this.disposeEmitter.fire({ webviewId, viewType: frame.viewType });
  }

  /** The extension host went away: every webview it owned is dead. */
  disposeAll(): void {
    for (const webviewId of [...this.frames.keys()]) {
      this.dispose(webviewId);
    }
  }

  has(webviewId: string): boolean {
    return this.frames.has(webviewId);
  }

  /** Searches inside one webview; the answer arrives on onDidFindResult. */
  find(webviewId: string, text: string, matchCase: boolean, direction: FindDirection): void {
    const control: ShellToWebviewControl = { ccwControl: 'find', text, matchCase, direction };
    this.get(webviewId)?.post(control);
  }

  stopFind(webviewId: string): void {
    const control: ShellToWebviewControl = { ccwControl: 'findStop' };
    this.frames.get(webviewId)?.post(control);
  }

  setTheme(theme: ThemeData): void {
    const control: ShellToWebviewControl = { ccwControl: 'theme', theme };
    for (const frame of this.frames.values()) {
      frame.post(control);
    }
  }

  /** Translates the extension's UI text in every webview that can be (see WebviewPageHints); null: stop. */
  setTranslations(translations: ExtensionTranslations | null): void {
    const control: ShellToWebviewControl = { ccwControl: 'translations', translations };
    for (const frame of this.frames.values()) {
      frame.post(control);
    }
  }

  /**
   * The comment blocks a webview shows above its input, and the text of its own they are on
   * (pages with a place for them, see WebviewPageHints). A new document starts without: send
   * them again on `onDidLoad`.
   */
  setComments(webviewId: string, view: CommentsViewDto | null): void {
    const control: ShellToWebviewControl = { ccwControl: 'comments', view };
    this.frames.get(webviewId)?.post(control);
  }

  /** Asks a conversation page for its selected text: the answer is a `selection` comments event with `id`. */
  requestCommentSelection(webviewId: string, id: number): void {
    const control: ShellToWebviewControl = { ccwControl: 'commentSelection', id };
    this.get(webviewId)?.post(control);
  }

  /** Scrolls a conversation page to commented text of its own and flashes it. */
  revealQuote(webviewId: string, quote: ConversationQuoteDto): void {
    const control: ShellToWebviewControl = { ccwControl: 'revealQuote', quote };
    this.get(webviewId)?.post(control);
  }

  /**
   * Plays a conversation page its own use of Escape that the shell took over: interrupting
   * Claude, or the rewind picker (pages with `hints.conversationEscapes`).
   */
  playEscape(webviewId: string, action: 'interrupt' | 'rewind'): void {
    const control: ShellToWebviewControl = { ccwControl: 'escape', action };
    this.get(webviewId)?.post(control);
  }

  /** Shows or hides the markers by every conversation's scrollbar (pages with `hints.messageMarkers`). */
  setMessageMarkers(enabled: boolean): void {
    const control: ShellToWebviewControl = { ccwControl: 'messageMarkers', enabled };
    for (const frame of this.frames.values()) {
      frame.post(control);
    }
  }

  /** Scrolls a conversation to the user's message before or after the one in view. */
  jumpToMessage(webviewId: string, direction: 'previous' | 'next'): void {
    const control: ShellToWebviewControl = { ccwControl: 'jumpToMessage', direction };
    this.get(webviewId)?.post(control);
  }

  /** Tells a page what to do with a file link's held message: pass it on to the extension, or drop it. */
  answerFileLink(webviewId: string, id: number, release: boolean): void {
    const control: ShellToWebviewControl = { ccwControl: 'fileLink', id, release };
    this.frames.get(webviewId)?.post(control);
  }

  /** The iframe that shows a webview, e.g. to place shell UI over a spot of its page. */
  element(webviewId: string): HTMLIFrameElement | undefined {
    return this.frames.get(webviewId)?.iframe;
  }

  private get(webviewId: string): WebviewFrame | undefined {
    const frame = this.frames.get(webviewId);
    if (!frame) {
      this.logger.warn(`unknown webview ${webviewId}`);
    }
    return frame;
  }

  private onWindowMessage(event: MessageEvent, receiver: Window = window): void {
    if (!event.source || event.source === receiver) {
      return;
    }
    const frame = [...this.frames.values()].find((f) => f.contentWindow === event.source);
    if (!frame) {
      return;
    }
    const data = event.data as Partial<WebviewToShellMessage> | null;
    if (!data || data.ccw !== frame.webviewId) {
      return;
    }
    const webviewId = frame.webviewId;
    switch (data.kind) {
      case 'message':
        this.connection.rpc?.notify('webview.didReceiveMessage', { webviewId, message: data.message });
        break;
      case 'state':
        this.connection.rpc?.notify('webview.didUpdateState', { webviewId, state: data.state });
        break;
      case 'link':
        if (typeof data.href === 'string') {
          void native.call('os.openExternal', { url: data.href });
        }
        break;
      case 'keydown':
        if (data.event) {
          this.keyEmitter.fire({ webviewId, event: data.event });
        }
        break;
      case 'findResult':
        this.findEmitter.fire({ webviewId, matches: data.matches ?? 0, active: data.active ?? 0 });
        break;
      case 'comments':
        if (data.event) {
          this.commentsEmitter.fire({ webviewId, event: data.event });
        }
        break;
      case 'focus':
      case 'blur':
        this.focusEmitter.fire({ webviewId, focused: data.kind === 'focus' });
        break;
      case 'deleteSession':
        if (typeof data.sessionId === 'string') {
          this.deleteSessionEmitter.fire({ sessionId: data.sessionId, title: typeof data.title === 'string' ? data.title : '' });
        }
        break;
      case 'navigate':
        if (data.direction === 'back' || data.direction === 'forward') {
          this.navigateEmitter.fire(data.direction);
        }
        break;
      case 'editPrices':
        this.editPricesEmitter.fire();
        break;
      case 'fullTranscript':
        this.fullTranscriptEmitter.fire(webviewId);
        break;
      case 'toggleProviderFilter':
        this.providerFilterEmitter.fire();
        break;
      case 'switchProvider':
        if (typeof data.providerId === 'string' && typeof data.sessionId === 'string') {
          this.switchProviderEmitter.fire({ providerId: data.providerId, sessionId: data.sessionId });
        }
        break;
      case 'fileLink':
        if (typeof data.id === 'number' && typeof data.path === 'string' && (data.intent === 'system' || data.intent === 'menu')) {
          const link = typeof data.link === 'string' ? data.link : undefined;
          this.fileLinkEmitter.fire({ webviewId, id: data.id, path: data.path, intent: data.intent, link });
        }
        break;
      case 'fileDrag':
        if (
          (data.phase === 'over' || data.phase === 'leave' || data.phase === 'drop' || data.phase === 'end') &&
          typeof data.x === 'number' &&
          typeof data.y === 'number'
        ) {
          this.fileDragEmitter.fire({ webviewId, phase: data.phase, x: data.x, y: data.y });
        }
        break;
      default:
        this.logger.warn(`unknown message kind from webview ${webviewId}`);
    }
  }
}
