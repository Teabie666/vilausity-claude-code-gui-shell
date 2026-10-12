/**
 * Message-level adaptations between the Claude Code webview and its extension.
 *
 * Everything here depends on the extension's PRIVATE webview protocol (verified against
 * anthropic.claude-code 2.1.282). Re-check this file whenever the extension updates.
 *
 *   webview -> extension  { type: 'request', channelId, requestId, request: { type, ... } }
 *                         { type: 'cancel_request', targetRequestId }
 *                         { type: 'io_message', channelId, message, done }   (user input)
 *   extension -> webview  { type: 'from-extension', message: { type: 'response', requestId, response } }
 *
 * Keep this the only place outside compat/ that knows about those shapes, and about the
 * extension's pages (the selectors in the page hints, the state they save).
 */

import { randomUUID } from 'node:crypto';
import { CHAT_PANEL_VIEW_TYPE, type WebviewImpl, type WebviewMessageInterceptor } from '../../compat/vscode/webviews';
import type { OsBackend } from '../../compat/vscode/host';
import type { ILogger } from '../../platform/log';
import type { SessionBusy, SessionRowHints, WebviewPageHints } from '../../platform/protocol';
import { formatComments, type PendingComments } from './comments';

interface WebviewRequest {
  readonly type: 'request';
  readonly channelId?: string;
  readonly requestId: string;
  readonly request: { readonly type: string; readonly [key: string]: unknown };
}

/**
 * The conversation's message input and the form around it (anthropic.claude-code 2.1.282:
 * `form > fieldset > div > div[role=textbox][aria-label="Message input"]`, inside a
 * bottom-anchored container whose height the page measures to keep the last message above
 * it). Comment blocks go right before the form, so the page makes room for them too.
 */
const CHAT_INPUT_FORM = 'form:has([role="textbox"][aria-label="Message input"])';

/** The session list view and the plan preview panel (anthropic.claude-code 2.1.282). */
const SESSION_LIST_VIEW_TYPE = 'claudeVSCodeSessionsList';
const PLAN_PREVIEW_VIEW_TYPE = 'claudePlanPreview';

/**
 * Where the extension's pages show content rather than their own UI, which the translation
 * of the UI text leaves alone (anthropic.claude-code 2.1.282; the conversation and the session
 * list are one bundle, so one list serves both): the conversation; Markdown (a plan in a
 * permission prompt); a user message wherever it is repeated; what Claude asks in a question
 * card (tab header, question, options); what a permission prompt shows of the tool call (a
 * command's description, a skill's description and arguments, the file, the JSON input; a
 * command is editable, which the translation skips anyway; the plan prompt's description is
 * the extension's own text, so the description class only counts after those); session, group
 * and worktree names; the session title in the conversation's header.
 */
const PAGE_CONTENT = [
  '[aria-label="Claude Code conversation"]',
  '.root_-a7MRw',
  '.userMessage_07S1Yg',
  '.navTabLabel_hONcXw',
  '.questionTextLarge_hONcXw',
  '.optionLabel_hONcXw',
  '.optionDescription_hONcXw',
  '.permissionRequestInput_qlaBag ~ .permissionRequestDescription_qlaBag',
  '.skillNote_qlaBag ~ .permissionRequestDescription_qlaBag',
  '.permissionPath_qlaBag',
  '.inputJson_qlaBag',
  '.sessionName_OOQiHg',
  '.sessionName_AsP4Bg',
  '.groupName_OOQiHg',
  '.worktreePillName_OOQiHg',
  '.titleText_aqhumA',
].join(', ');

/** The plan preview's plan, and the text a comment there quotes. */
const PLAN_PREVIEW_CONTENT = '#content, #selected-text-preview';

/**
 * The extension's pages in the shell's fonts (anthropic.claude-code 2.1.296). The extension
 * sets one font for its whole page from VS Code's chat settings: `--vscode-chat-font-family`
 * and `--vscode-chat-font-size` (buttons, menus, the session list and the conversation alike),
 * and `--vscode-editor-font-*` for code, which it writes on the root element itself
 * (`font_configuration_changed`). The shell makes the first the UI font (`workbench.*`) and
 * the second the conversation's code font (`chat.editor.*`); `!important` wins over the
 * values on the root element. The conversation's own text gets the conversation font below.
 */
const FONT_STYLES = `
:root {
  --vscode-chat-font-family: var(--vscode-font-family) !important;
  --vscode-chat-font-size: var(--vscode-font-size) !important;
  --vscode-editor-font-family: var(--vilaus-chat-code-font-family) !important;
  --vscode-editor-font-size: var(--vilaus-chat-code-font-size) !important;
}
`;

/**
 * The extension's own orange in the window's accent (anthropic.claude-code 2.1.296): it draws
 * the send button, the message input's focus ring, links, pills and badges in
 * `--app-claude-orange` and `--app-claude-clay-button-orange` (declared on html), with ivory
 * text on the send button. In the modes that act without asking (auto, bypassPermissions)
 * it turns the send button and the input's focus ring red instead; those take the accent too,
 * and the mode's button by the input says so instead, on a tint of its own: red for
 * bypassPermissions, amber for auto (whose icon is amber too). The accent variables come with the
 * theme (platform/accent.ts); without an accent they are unset and the fallbacks are the
 * extension's own values.
 */
const ACCENT_STYLES = `
html {
  --app-claude-orange: var(--vilaus-accent-line, #d97757) !important;
  --app-claude-clay-button-orange: var(--vilaus-accent-fill, #c6613f) !important;
}
.sendButton_gGYT1w,
.sendButton_UCAeZQ { color: var(--vilaus-accent-fill-foreground, var(--app-claude-ivory)); }
.sendButton_gGYT1w:is([data-permission-mode=auto], [data-permission-mode=bypassPermissions]) {
  color: var(--vilaus-accent-fill-foreground, var(--app-button-foreground));
  background-color: var(--vilaus-accent-fill, var(--app-error-foreground));
}
.sendButton_gGYT1w:is([data-permission-mode=auto], [data-permission-mode=bypassPermissions]) :is(.sendIcon_gGYT1w, .stopIcon_gGYT1w) {
  color: var(--vilaus-accent-fill-foreground, var(--app-button-foreground));
}
.inputContainer_cKsPxg:is([data-permission-mode=auto], [data-permission-mode=bypassPermissions]):focus-within {
  --focus-ring-color: var(--vilaus-accent-line, var(--app-error-foreground));
}
.inputFooter_gGYT1w:has(> .sendButton_gGYT1w[data-permission-mode=bypassPermissions]) {
  --vilaus-mode-color: var(--app-error-foreground);
}
.inputFooter_gGYT1w:has(> .sendButton_gGYT1w[data-permission-mode=auto]) {
  --vilaus-mode-color: var(--vscode-editorWarning-foreground, #cca700);
}
.inputFooter_gGYT1w:has(> .sendButton_gGYT1w:is([data-permission-mode=auto], [data-permission-mode=bypassPermissions])) .container_8RAulQ > .footerButtonPrimary_gGYT1w {
  padding-right: 8px;
  background-color: color-mix(in srgb, var(--vilaus-mode-color) 20%, transparent);
}
.inputFooter_gGYT1w:has(> .sendButton_gGYT1w:is([data-permission-mode=auto], [data-permission-mode=bypassPermissions])) .container_8RAulQ > .footerButtonPrimary_gGYT1w:hover {
  background-color: color-mix(in srgb, var(--vilaus-mode-color) 30%, transparent);
}
.inputFooter_gGYT1w:has(> .sendButton_gGYT1w:is([data-permission-mode=auto], [data-permission-mode=bypassPermissions])) .container_8RAulQ > .footerButtonPrimary_gGYT1w svg {
  color: var(--vilaus-mode-color);
}
`;

/**
 * The account's usage bars (5 hours, week; anthropic.claude-code 2.1.296) by how much is left
 * rather than in the accent: green with most of it left, yellow at half, red near the end.
 * The bar's width is the share used; the page script copies it into `--vilaus-meter`.
 */
const USAGE_METERS = '.usageFill_8s5nuw';
const USAGE_STYLES = `
.usageTrack_8s5nuw .usageFill_8s5nuw {
  background: color-mix(
    in oklab,
    var(--vscode-charts-red) calc(clamp(0, var(--vilaus-meter, 0) * 2 - 1, 1) * 100%),
    color-mix(in oklab, var(--vscode-charts-yellow) calc(clamp(0, var(--vilaus-meter, 0) * 2, 1) * 100%), var(--vscode-charts-green))
  );
}
`;

/**
 * The conversation's text in the conversation font (`chat.fontFamily`, `chat.fontSize`): a
 * user message, Claude's Markdown, thinking, and the message input with the mirror the page
 * draws its text in (both must agree, or the caret drifts from the text). Code in Markdown is
 * sized by the code font size instead of the page's `.9em`. Tool calls, buttons and menus stay
 * in the UI font. Class names of anthropic.claude-code 2.1.296.
 */
const CONVERSATION_STYLES = `
.userMessage_07S1Yg,
.root_-a7MRw,
.thinkingContent_aHyQPQ,
.messageInput_cKsPxg,
.mentionMirror_cKsPxg {
  font-family: var(--vilaus-chat-font-family);
  font-size: var(--vilaus-chat-font-size);
  line-height: var(--vilaus-chat-line-height);
}
.root_-a7MRw code,
.root_-a7MRw pre {
  font-size: var(--vilaus-chat-code-font-size);
}
.root_-a7MRw pre { line-height: 1.5; }
.root_-a7MRw pre code { font-size: inherit; }
`;

/**
 * The session list (the sidebar) in the shell's look (anthropic.claude-code 2.1.282 class
 * names, the same in 2.1.296; once a newer extension renames them, it just shows its own look
 * again):
 * - only the sessions scroll, the account and usage above them stay in place;
 * - "Account" and the address on one line, without the "Email" label;
 * - "New session" as a button;
 * - no Local / Web switch (remote sessions are not used from here);
 * - the "Active" toggle and the status filter's caret as one control;
 * - the search button as a search box taking the rest of its row (clicking it opens the
 *   page's own search field, as before); "New group" as just its icon, to leave it room.
 */
const SESSION_LIST_STYLES = `
.root_djirOA { overflow-y: hidden; }
.root_djirOA > :not(.sessionsBody_djirOA) { flex-shrink: 0; }
.accountUsageBody_djirOA { max-height: 50vh; overflow-y: auto; }
.sessionsBody_djirOA { flex: 1 1 auto; min-height: 0; }
.sessionsBody_djirOA > .root_OOQiHg { flex: 1 1 auto; min-height: 0; }
.content_OOQiHg.sessionListOnly_OOQiHg { flex: 1 1 auto; min-height: 0; overflow-y: auto; }

.accountUsageBody_djirOA .section_JuUW3A:has(.accountRows_djirOA) { flex-direction: row; align-items: baseline; gap: 8px; }
.accountRows_djirOA { flex: 1 1 auto; min-width: 0; }
.accountRows_djirOA .accountRow_JuUW3A { justify-content: flex-start; padding: 0; }
.accountRows_djirOA .accountLabel_JuUW3A { display: none; }
.accountRows_djirOA .accountValue_JuUW3A { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.headerRow_djirOA { gap: 6px; padding: 8px 12px 4px; border-bottom: none; }
.newSessionButton_djirOA {
  justify-content: center;
  padding: 4px 8px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.newSessionButton_djirOA:hover { background: var(--vscode-button-secondaryHoverBackground); }

.sessionsBody_djirOA .segmented_OOQiHg { display: none; }

.searchRowActions_OOQiHg { flex: 1 1 auto; flex-wrap: nowrap; }
.activeFilterToggle_OOQiHg,
.statusFilterMenuButton_OOQiHg {
  height: 24px;
  margin-left: 0;
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
}
.activeFilterToggle_OOQiHg { order: -1; border-radius: 4px 0 0 4px; }
.statusFilterMenuButton_OOQiHg { padding: 4px; border-left: none; border-radius: 0 4px 4px 0; }
.statusFilterMenuButton_OOQiHg > .newGroupIcon_OOQiHg { display: none; }

.searchRowTail_OOQiHg { flex: 1 1 auto; min-width: 0; margin-left: 6px; }
.searchRowTail_OOQiHg > .newGroupButton_OOQiHg:not(.searchToggleButton_OOQiHg) { gap: 0; padding: 4px; font-size: 0; }
.searchToggleButton_OOQiHg,
.searchToggleButton_OOQiHg:hover,
.searchToggleButton_OOQiHg:focus {
  flex: 1 1 auto;
  min-width: 0;
  justify-content: flex-start;
  gap: 6px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
  background: var(--vscode-input-background);
  color: var(--vscode-input-placeholderForeground);
}
.searchToggleButton_OOQiHg:hover { border-color: var(--vscode-focusBorder); }
.searchToggleButton_OOQiHg::after {
  content: attr(aria-label);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

/**
 * The session list's rows (anthropic.claude-code 2.1.296): `<button id="sessions-list-row-<session id>">`,
 * with its rename and archive buttons in `.sessionActions_OOQiHg`. The shell adds a delete
 * button next to them, in the same classes.
 */
const SESSION_ROWS: SessionRowHints = {
  row: 'button[id^="sessions-list-row-"]',
  idPrefix: 'sessions-list-row-',
  name: '.sessionName_OOQiHg',
  actions: '.sessionActions_OOQiHg',
  buttonClass: 'actionButton_OOQiHg',
  iconClass: 'actionIcon_OOQiHg',
};

/**
 * The session a conversation panel's page shows, from the state it saves
 * (anthropic.claude-code 2.1.282: `{ sessionID, sessionWithNoTranscript, ... }`, saved again
 * whenever the page's session changes). A new conversation gets a session id at once, but
 * until its first prompt the page marks it `sessionWithNoTranscript`: such a session is not
 * resumed (a restored panel starts over under a new id), so it does not count yet.
 */
export function conversationSessionId(state: unknown): string | undefined {
  if (!isRecord(state)) {
    return undefined;
  }
  const sessionId = state.sessionID;
  return typeof sessionId === 'string' && sessionId.length > 0 && state.sessionWithNoTranscript !== sessionId
    ? sessionId
    : undefined;
}

export interface BridgeOptions {
  /**
   * Whether vilaus can show diff editors. Until M2 it cannot, and the webview must
   * then not wait on `open_diff`, or it auto-rejects every edit (see below).
   */
  readonly diffEditorAvailable: () => boolean;
  /** Comments waiting for their conversation's next message. */
  readonly comments: PendingComments;
  /** For the paths in comments: relative to the workspace when inside it. */
  readonly workspaceFolders: readonly string[];
}

export class ClaudeWebviewBridge implements WebviewMessageInterceptor {
  /** `open_diff` requests we are holding, by requestId. */
  private readonly heldDiffs = new Map<string, WebviewImpl>();
  private loggedInputShape = false;
  /** Sessions open in this window's panels, and held by another process, as the extension last said. */
  private openSessions = new Set<string>();
  private elsewhereSessions = new Set<string>();
  private loggedStatesShape = false;

  constructor(
    private readonly os: OsBackend,
    private readonly logger: ILogger,
    private readonly options: BridgeOptions,
  ) {}

  interceptFromWebview(webview: WebviewImpl, message: unknown): boolean {
    if (!isRecord(message)) {
      return false;
    }
    if (message.type === 'cancel_request' && typeof message.targetRequestId === 'string') {
      return this.releaseHeldDiff(message.targetRequestId);
    }
    if (message.type === 'io_message') {
      this.logInputShapeOnce(message);
      this.attachComments(webview, message);
      return false;
    }
    if (!isWebviewRequest(message)) {
      return false;
    }
    switch (message.request.type) {
      case 'open_diff':
        return this.holdDiff(webview, message);
      case 'accept_diff':
        return this.answerAcceptDiff(webview, message);
      case 'open_url':
        return this.openUrl(webview, message);
      default:
        return false;
    }
  }

  /**
   * Edit/Write permission flow (anthropic.claude-code 2.1.282): the webview sends
   * `open_diff` and treats an empty answer as "user cancelled the edit". With no diff
   * editor we hold the request; the user decides in the chat's inline prompt, after which
   * the webview cancels the request and we answer it empty, exactly as VS Code does when
   * the diff tab is closed.
   */
  private holdDiff(webview: WebviewImpl, message: WebviewRequest): boolean {
    if (this.options.diffEditorAvailable()) {
      return false;
    }
    this.heldDiffs.set(message.requestId, webview);
    this.logger.debug(`holding open_diff ${message.requestId} (no diff editor)`);
    return true;
  }

  private releaseHeldDiff(requestId: string): boolean {
    const webview = this.heldDiffs.get(requestId);
    if (!webview) {
      return false;
    }
    this.heldDiffs.delete(requestId);
    respond(webview, requestId, { type: 'open_diff_response' });
    return true;
  }

  /**
   * Inline "accept" first asks the extension to accept from the diff tab (`accept_diff`);
   * `found: false` makes the webview fall back to accepting directly.
   */
  private answerAcceptDiff(webview: WebviewImpl, message: WebviewRequest): boolean {
    if (this.options.diffEditorAvailable()) {
      return false;
    }
    respond(webview, message.requestId, { type: 'accept_diff_response', found: false });
    return true;
  }

  /** Opens the exact URL string; going through `Uri.parse` can alter query encoding. */
  private openUrl(webview: WebviewImpl, message: WebviewRequest): boolean {
    const url = message.request.url;
    if (typeof url !== 'string') {
      return false;
    }
    void this.os.openExternal(url).catch((error: unknown) => this.logger.warn(`open_url failed: ${url}`, error));
    respond(webview, message.requestId, { type: 'open_url_response' });
    return true;
  }

  /**
   * The extension tells its pages which sessions are in use (anthropic.claude-code 2.1.296:
   * `{type: 'from-extension', message: {type: 'request', request: {type: 'session_states_update',
   * openSessionIds?, liveElsewhereSessions?, ...}}}`, the same to every page; a field left out
   * keeps its last value). Open: in a panel of this window. Elsewhere: Claude Code holds it in
   * another process (another window, VS Code, the CLI), which the extension learns from the
   * records Claude Code keeps of its running sessions.
   */
  observeToWebview(_webview: WebviewImpl, message: unknown): void {
    const inner = isRecord(message) && message.type === 'from-extension' ? message.message : undefined;
    const request = isRecord(inner) && inner.type === 'request' && isRecord(inner.request) ? inner.request : undefined;
    if (request?.type !== 'session_states_update') {
      return;
    }
    if (!this.loggedStatesShape) {
      this.loggedStatesShape = true;
      this.logger.info(`session_states_update shape: ${describeShape(request)}`);
    }
    if (Array.isArray(request.openSessionIds)) {
      this.openSessions = new Set(request.openSessionIds.flatMap(sessionIdOf));
    }
    if (Array.isArray(request.liveElsewhereSessions)) {
      this.elsewhereSessions = new Set(request.liveElsewhereSessions.flatMap(sessionIdOf));
    }
  }

  sessionBusy(sessionId: string): SessionBusy | undefined {
    return this.openSessions.has(sessionId) ? 'open' : this.elsewhereSessions.has(sessionId) ? 'elsewhere' : undefined;
  }

  /**
   * Sessions were deleted behind the extension's back: its pages list them again, through the
   * request the extension itself sends when Claude Code's folder moves (`session_store_changed`,
   * anthropic.claude-code 2.1.296; the page re-reads its list and does not answer).
   */
  sessionStoreChanged(webviews: Iterable<WebviewImpl>): void {
    for (const webview of webviews) {
      if (webview.viewType !== SESSION_LIST_VIEW_TYPE && webview.viewType !== CHAT_PANEL_VIEW_TYPE) {
        continue;
      }
      const request = { type: 'request', channelId: '', requestId: randomUUID(), request: { type: 'session_store_changed' } };
      void webview.postMessage({ type: 'from-extension', message: request });
    }
  }

  pageHints(webview: WebviewImpl): WebviewPageHints | undefined {
    switch (webview.viewType) {
      case CHAT_PANEL_VIEW_TYPE:
        return {
          commentsAnchor: CHAT_INPUT_FORM,
          untranslated: PAGE_CONTENT,
          styles: FONT_STYLES + ACCENT_STYLES + USAGE_STYLES + CONVERSATION_STYLES,
          meters: USAGE_METERS,
        };
      case SESSION_LIST_VIEW_TYPE:
        return {
          untranslated: PAGE_CONTENT,
          styles: FONT_STYLES + ACCENT_STYLES + USAGE_STYLES + SESSION_LIST_STYLES,
          meters: USAGE_METERS,
          sessionRows: SESSION_ROWS,
        };
      case PLAN_PREVIEW_VIEW_TYPE:
        return { untranslated: PLAN_PREVIEW_CONTENT };
      default:
        // Another page (a newer extension's): not translated until its content is known.
        return undefined;
    }
  }

  /**
   * A user message takes its conversation's comments along, as one more text block after
   * what the user typed; the typed text itself is left alone. In 2.1.282 an `io_message`
   * carries `{type: "user", message: {role: "user", content: [...]}}`, and the typed text
   * is the last text block (context such as the editor selection comes first). Slash
   * commands (`/compact`...) go out the same way; they leave the comments for the next message.
   */
  private attachComments(webview: WebviewImpl, message: Record<string, unknown>): void {
    const store = this.options.comments;
    if (store.list(webview.id).length === 0) {
      return;
    }
    const user = message.message;
    if (!isRecord(user) || user.type !== 'user' || !isRecord(user.message)) {
      return;
    }
    const inner = user.message;
    const content: unknown[] | undefined =
      typeof inner.content === 'string' ? [{ type: 'text', text: inner.content }] : Array.isArray(inner.content) ? inner.content : undefined;
    if (!content) {
      this.logger.warn(`io_message content is ${describeShape(inner.content)}; comments not attached`);
      return;
    }
    const typed = content.findLast((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string');
    if (isRecord(typed) && String(typed.text).trimStart().startsWith('/')) {
      return;
    }
    const comments = store.take(webview.id);
    inner.content = [...content, { type: 'text', text: formatComments(comments, this.options.workspaceFolders) }];
    this.logger.info(`attached ${comments.length} comment(s) to a message`);
  }

  /** Records the structure (never the content) of the first user message, for the comments feature (M3). */
  private logInputShapeOnce(message: Record<string, unknown>): void {
    if (this.loggedInputShape) {
      return;
    }
    this.loggedInputShape = true;
    this.logger.info(`io_message shape: ${describeShape(message)}`);
  }
}

function respond(webview: WebviewImpl, requestId: string, response: Record<string, unknown>): void {
  void webview.postMessage({ type: 'from-extension', message: { type: 'response', requestId, response } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A session in the extension's lists: its id, or a record with a `sessionId`. */
function sessionIdOf(entry: unknown): string[] {
  if (typeof entry === 'string') {
    return [entry];
  }
  return isRecord(entry) && typeof entry.sessionId === 'string' ? [entry.sessionId] : [];
}

function isWebviewRequest(value: Record<string, unknown>): value is Record<string, unknown> & WebviewRequest {
  return (
    value.type === 'request' &&
    typeof value.requestId === 'string' &&
    isRecord(value.request) &&
    typeof value.request.type === 'string'
  );
}

/** Discriminant fields whose values are protocol vocabulary, not user content. */
const LITERAL_KEYS = new Set(['type', 'role']);

/**
 * `{type: "user", message: {content: [...]}}`-style summary with no user content.
 * Arrays are described by their first element only: enough to learn a message format.
 */
export function describeShape(value: unknown, depth = 0): string {
  if (Array.isArray(value)) {
    return depth > 4 ? 'array' : `[${value.length > 0 ? describeShape(value[0], depth + 1) : ''}]`;
  }
  if (isRecord(value)) {
    if (depth > 4) {
      return 'object';
    }
    const fields = Object.entries(value).map(([key, field]) =>
      LITERAL_KEYS.has(key) && typeof field === 'string'
        ? `${key}: ${JSON.stringify(field)}`
        : `${key}: ${describeShape(field, depth + 1)}`,
    );
    return `{${fields.join(', ')}}`;
  }
  return typeof value;
}
