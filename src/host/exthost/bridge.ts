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

import { CHAT_PANEL_VIEW_TYPE, type WebviewImpl, type WebviewMessageInterceptor } from '../../compat/vscode/webviews';
import type { OsBackend } from '../../compat/vscode/host';
import type { ILogger } from '../../platform/log';
import type { WebviewPageHints } from '../../platform/protocol';
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
 * The session list (the sidebar) in the shell's look (anthropic.claude-code 2.1.282 class
 * names; once a newer extension renames them, it just shows its own look again):
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

  pageHints(webview: WebviewImpl): WebviewPageHints | undefined {
    switch (webview.viewType) {
      case CHAT_PANEL_VIEW_TYPE:
        return { commentsAnchor: CHAT_INPUT_FORM, untranslated: PAGE_CONTENT };
      case SESSION_LIST_VIEW_TYPE:
        return { untranslated: PAGE_CONTENT, styles: SESSION_LIST_STYLES };
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
