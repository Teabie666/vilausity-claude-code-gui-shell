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
import type {
  ConversationCommentHints,
  ConversationEscapeHints,
  ConversationStateDto,
  FileLinkHints,
  MessageMarkerHints,
  PromptSubmitHints,
  PromptSubmitOutcome,
  PromptSubmitReply,
  SessionActivity,
  SessionBusy,
  SessionRowHints,
  ShellToWebviewControl,
  StatusFilterHints,
  StreamMergeHints,
  StreamMergeRule,
  UsageBarHints,
  ProviderNoticeDto,
  SessionProvidersDto,
  UsageBlockHints,
  UsageViewDto,
  WebviewPageHints,
} from '../../platform/protocol';
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

/**
 * The conversation page's own uses of a plain Escape (anthropic.claude-code 2.1.296), which the
 * shell makes keybindings instead: one that reaches the page's body unprevented interrupts
 * Claude (unless a permission prompt waits), and two in the empty message input within 800 ms
 * open the rewind picker. Its other uses of Escape (menus, dialogs, editing a message) work
 * the same when it is prevented.
 */
const CONVERSATION_ESCAPES: ConversationEscapeHints = {
  input: '[role="textbox"][aria-label="Message input"]',
  doubleMs: 800,
};

/**
 * A conversation's message input (anthropic.claude-code 2.1.306: a `contenteditable` that takes
 * text inserted with `execCommand('insertText')`, and sends on an Enter keydown, a dispatched
 * one too, then empties).
 */
const PROMPT_SUBMIT: PromptSubmitHints = { input: CONVERSATION_ESCAPES.input };
/** How long a page may take to answer `submitPrompt` (it waits for its input to show up first). */
const SUBMIT_TIMEOUT_MS = 30_000;

/**
 * What a conversation page gets a token at a time (anthropic.claude-code 2.1.296): Claude
 * Code's stream events as they come, `{type: 'from-extension', message: {type: 'io_message',
 * channelId, message, done: false}}` where `message` is
 *   `{type: 'stream_event', event: {type: 'content_block_delta', index, delta}, parent_tool_use_id, ...}`
 * with `delta` `{type: 'text_delta', text}`, `{type: 'input_json_delta', partial_json}` (a tool
 * call's input) or `{type: 'thinking_delta', thinking}`, and after each thinking delta
 *   `{type: 'system', subtype: 'thinking_tokens', estimated_tokens, estimated_tokens_delta, ...}`
 * (the running count, and what this delta added). A run of deltas of one content block merges
 * into one delta with the text joined; a run of token counts into the latest count, with the
 * added tokens summed. DeepSeek's API sends one event per token (200 to 1000 a second), and the
 * page renders the whole conversation for each one: a long conversation fell minutes behind.
 */
const IO_MESSAGE: StreamMergeRule['match'] = [
  [['type'], 'from-extension'],
  [['message', 'type'], 'io_message'],
  [['message', 'done'], false],
];
const STREAM_KEY: StreamMergeRule['key'] = [
  ['message', 'channelId'],
  ['message', 'message', 'parent_tool_use_id'],
];
const deltaRule = (type: string, field: string): StreamMergeRule => ({
  match: [
    ...IO_MESSAGE,
    [['message', 'message', 'type'], 'stream_event'],
    [['message', 'message', 'event', 'type'], 'content_block_delta'],
    [['message', 'message', 'event', 'delta', 'type'], type],
  ],
  key: [...STREAM_KEY, ['message', 'message', 'event', 'index']],
  append: ['message', 'message', 'event', 'delta', field],
});
export const STREAM_MERGE: StreamMergeHints = {
  rules: [
    deltaRule('text_delta', 'text'),
    deltaRule('input_json_delta', 'partial_json'),
    deltaRule('thinking_delta', 'thinking'),
    {
      match: [...IO_MESSAGE, [['message', 'message', 'type'], 'system'], [['message', 'message', 'subtype'], 'thinking_tokens']],
      key: STREAM_KEY,
      sum: [['message', 'message', 'estimated_tokens_delta']],
    },
  ],
  intervalMs: 50,
};

/**
 * What opens a file in a conversation page (anthropic.claude-code 2.1.306): a click on a link
 * in Claude's Markdown (`a[href]`, which the page also uses for web links: those post
 * `open_url`), on an @-mention in a user message (`span.mentionChip_*[role=button]`), or on the
 * file name of a tool call such as Read or Edit (`a[href="#"]` in `.toolNameTextSecondary_*`).
 * Each posts `{type: 'request', channelId, requestId, request: {type: 'open_file', filePath,
 * location}}` from the click itself; the extension answers `open_file_response`. The
 * attachment pills of a message are left out: some of them preview an image when clicked.
 */
export const FILE_LINKS: FileLinkHints = {
  selector: ['.root_-a7MRw a[href]', '[class*="mentionChip_"][role="button"]', '[class*="toolNameTextSecondary_"] a[href]'].join(', '),
  request: [
    [['type'], 'request'],
    [['request', 'type'], 'open_file'],
  ],
  path: ['request', 'filePath'],
};

/**
 * A thinking block's summary (anthropic.claude-code 2.1.306): `details.thinking_aHyQPQ >
 * summary.thinkingSummary_aHyQPQ`. One state opens or closes every thinking block of the
 * conversation, so a click on one moves the others' content: the clicked summary is kept in
 * place on screen.
 */
const THINKING_SUMMARY = 'details[class*="thinking_"] > summary[class*="thinkingSummary_"]';

/**
 * A question card (AskUserQuestion; anthropic.claude-code 2.1.310, 2.1.302 alike): each option
 * is a `div.option_hONcXw[role=radio|checkbox]` that a click picks (an answered question's are
 * read only), its `.optionLabel_hONcXw` and `.optionDescription_hONcXw` in `.optionContent_hONcXw`;
 * the question is `.questionTextLarge_hONcXw`. The page makes it all unselectable (`user-select:
 * none` far up), so an option's text could not be copied into an answer of one's own (Other).
 */
const QUESTION_OPTION = '.option_hONcXw';
const QUESTION_TEXT = '.questionTextLarge_hONcXw, .optionLabel_hONcXw, .optionDescription_hONcXw';

/**
 * A conversation's turns (anthropic.claude-code 2.1.306): `div.messagesContainer_07S1Yg`
 * (the scrolling element) holds a `div.turn_07S1Yg` per message of the user's, which starts
 * with it (`.userMessage_07S1Yg`) and goes on with the replies.
 */
const MESSAGE_MARKERS: MessageMarkerHints = { turn: '.turn_07S1Yg', userMessage: '.userMessage_07S1Yg' };

/**
 * A conversation's messages (anthropic.claude-code 2.1.306): each is a `div.message_07S1Yg
 * [role=article][data-transcript-message]` in its turn. Claude's carry their uuid in
 * `data-bookmark-uuid`: a reply (Markdown in `span.root_-a7MRw`), a tool call, or the thinking
 * (`details.thinking_aHyQPQ > summary.thinkingSummary_aHyQPQ + div.thinkingContent_aHyQPQ`;
 * the content is there while the block is closed), or several of these when one message of the
 * transcript has them. The user's carries no uuid; its words are in `.userMessage_07S1Yg`, after
 * a hidden heading and the time.
 */
const CONVERSATION_COMMENTS: ConversationCommentHints = {
  message: '[data-transcript-message]',
  uuidAttribute: 'data-bookmark-uuid',
  userText: '.userMessage_07S1Yg',
  thinking: '[class*="thinkingContent_"]',
  thinkingToggle: 'details[class*="thinking_"] > summary[class*="thinkingSummary_"]',
  turn: '.turn_07S1Yg',
};

/** The session list view and the plan preview panel (anthropic.claude-code 2.1.282). */
const SESSION_LIST_VIEW_TYPE = 'claudeVSCodeSessionsList';
const PLAN_PREVIEW_VIEW_TYPE = 'claudePlanPreview';

/**
 * What the session list's page asks when a row is clicked (anthropic.claude-code 2.1.296):
 * `{type: 'request', requestId, request: {type: 'open_in_editor', sessionId, ...}}`. The
 * extension runs `claude-vscode.editor.open`, which creates the session's conversation panel
 * (or brings its open one forward), and then answers `open_in_editor_response`.
 */
const OPEN_IN_EDITOR = 'open_in_editor';
/** Two opens of one session this close together are its row double-clicked (ms; Windows' default). */
const DOUBLE_CLICK_MS = 500;
/** An open still unanswered after this long no longer makes previews (ms). */
const OPEN_TIMEOUT_MS = 5000;

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
.resetText_8s5nuw[data-vilaus-reset] { font-size: 0; }
.resetText_8s5nuw[data-vilaus-reset]::after {
  content: attr(data-vilaus-reset);
  font-size: var(--vilaus-reset-size);
}
`;

/**
 * A usage bar (anthropic.claude-code 2.1.296): its label ("Session (5hr)"...) and "Resets in 3h",
 * which the page works out when it renders, rounded down to minutes, hours or days. The page
 * script shows the time itself instead ("Resets 15:42"; styles above), from `usageResetsOf`.
 */
const USAGE_BARS: UsageBarHints = {
  bar: '.usageBarContainer_8s5nuw',
  label: '.usageLabel_8s5nuw',
  reset: '.resetText_8s5nuw',
};

/** The bars' labels for the windows of `panel_usage_update` and of `get_usage_response`'s rate limits. */
const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: 'Session (5hr)',
  seven_day: 'Weekly (7 day)',
  seven_day_sonnet: 'Weekly Sonnet',
  seven_day_overage_included: 'Fable limit',
};

/**
 * When each usage bar resets (epoch ms) by its label, from a message the extension posts to a
 * page (anthropic.claude-code 2.1.296), or undefined when it carries none. Two carry them:
 * - `panel_usage_update` (pushed after Claude's replies): `unifiedWindows.<window>.resetsAt`,
 *   in seconds;
 * - `get_usage_response` (the page asks): `usage.rate_limits.<window>.resets_at`, an ISO date,
 *   and per model `rate_limits.model_scoped[]` with `display_name` ("Weekly <name>").
 */
export function usageResetsOf(message: unknown): Record<string, number> | undefined {
  const inner = isRecord(message) && message.type === 'from-extension' ? message.message : undefined;
  if (!isRecord(inner)) {
    return undefined;
  }
  const resets: Record<string, number> = {};
  const request = inner.type === 'request' && isRecord(inner.request) ? inner.request : undefined;
  if (request?.type === 'panel_usage_update' && isRecord(request.unifiedWindows)) {
    for (const [window, value] of Object.entries(request.unifiedWindows)) {
      const label = WINDOW_LABELS[window];
      if (label && isRecord(value) && typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt)) {
        resets[label] = value.resetsAt * 1000;
      }
    }
  }
  const response = inner.type === 'response' && isRecord(inner.response) ? inner.response : undefined;
  const limits = response?.type === 'get_usage_response' && isRecord(response.usage) ? response.usage.rate_limits : undefined;
  if (isRecord(limits)) {
    const add = (label: string, value: unknown): void => {
      const at = isRecord(value) && typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : Number.NaN;
      if (Number.isFinite(at)) {
        resets[label] = at;
      }
    };
    for (const [window, value] of Object.entries(limits)) {
      const label = WINDOW_LABELS[window];
      if (label) {
        add(label, value);
      }
    }
    if (Array.isArray(limits.model_scoped)) {
      for (const scoped of limits.model_scoped) {
        if (isRecord(scoped) && typeof scoped.display_name === 'string') {
          add(`Weekly ${scoped.display_name}`, scoped);
        }
      }
    }
  }
  return Object.keys(resets).length > 0 ? resets : undefined;
}

/**
 * A message to a page without the extension's figures of what conversations cost, or
 * undefined when it carries none (anthropic.claude-code 2.1.296). The CLI works them out with
 * Claude's prices, and a model it does not know costs what Opus does; for a compatible API the
 * shell shows its own. Two carry them: `active_session_totals_update {session}` (the session
 * list's "Account & usage", which shows only while there is a session), and
 * `get_usage_response`'s `usage.session` ("View details"; without it the dialog says the
 * login method has no limits to show).
 */
export function withoutExtensionCosts(message: unknown): unknown {
  const inner = isRecord(message) && message.type === 'from-extension' ? message.message : undefined;
  if (!isRecord(message) || !isRecord(inner)) {
    return undefined;
  }
  const request = inner.type === 'request' && isRecord(inner.request) ? inner.request : undefined;
  if (request?.type === 'active_session_totals_update' && request.session !== null && request.session !== undefined) {
    return { ...message, message: { ...inner, request: { ...request, session: null } } };
  }
  const response = inner.type === 'response' && isRecord(inner.response) ? inner.response : undefined;
  if (response?.type === 'get_usage_response' && isRecord(response.usage) && response.usage.session !== undefined) {
    const { session: _session, ...usage } = response.usage;
    return { ...message, message: { ...inner, response: { ...response, usage } } };
  }
  return undefined;
}

/**
 * The conversation's text in the conversation font (`chat.fontFamily`, `chat.fontSize`): a
 * user message, Claude's Markdown, thinking, and the message input with the mirror the page
 * draws its text in (both must agree, or the caret drifts from the text). Code in Markdown is
 * sized by the code font size instead of the page's `.9em`. Tool calls, buttons and menus stay
 * in the UI font. Class names of anthropic.claude-code 2.1.296. A question card's text can be
 * selected (`QUESTION_TEXT`, 2.1.310).
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

${QUESTION_TEXT} {
  user-select: text;
  cursor: text;
}

.vilaus-provider-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin: 0 0 6px;
  padding: 6px 8px;
  border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWarning-foreground, #cca700));
  border-radius: 8px;
  background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  line-height: 18px;
  text-align: left;
}
.vilaus-provider-notice-text { flex: 1 1 200px; min-width: 0; }
.vilaus-provider-notice button {
  margin: 0;
  padding: 2px 8px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
}
.vilaus-provider-notice-switch { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.vilaus-provider-notice-switch:hover { background: var(--vscode-button-hoverBackground); }
.vilaus-provider-notice-switch[hidden] { display: none; }
.vilaus-provider-notice-ignore { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.vilaus-provider-notice-ignore:hover { background: var(--vscode-button-secondaryHoverBackground); }
`;

/**
 * The session list (the sidebar) in the shell's look (anthropic.claude-code 2.1.282 class
 * names, the same in 2.1.296 and 2.1.310; once a newer extension renames them, it just shows
 * its own look again):
 * - only the sessions scroll, the account and usage above them stay in place;
 * - "Account" and the address on one line, without the "Email" label;
 * - "New session" as a button;
 * - no Local / Web switch (remote sessions are not used from here);
 * - a row's rename, archive and delete buttons take no room until the row is hovered or
 *   focused, so its title shows as much as it has (the extension hides them but keeps their
 *   width);
 * - the status filter as one drop-down that shows the Active count (see STATUS_FILTER);
 * - the search button as a search box taking the rest of its row (clicking it opens the
 *   page's own search field, as before); when the row runs out of width it shrinks to just
 *   its icon; "New group" as just its icon, to leave it room. No button is ever clipped: the
 *   status label (then the count) gives way first.
 */
const SESSION_LIST_STYLES = `
.root_djirOA { overflow-y: hidden; }
.root_djirOA > :not(.sessionsBody_djirOA) { flex-shrink: 0; }
.accountUsageBody_djirOA { max-height: 50vh; overflow-y: auto; }
.sessionsBody_djirOA { flex: 1 1 auto; min-height: 0; }
.sessionsBody_djirOA > .root_OOQiHg { flex: 1 1 auto; min-height: 0; }
.content_OOQiHg.sessionListOnly_OOQiHg { flex: 1 1 auto; min-height: 0; overflow-y: auto; }

/* A row's time and buttons share a grid cell, so the hidden buttons would still hold their
   width. Out of the layout until hover or focus, the cell is just the time and the title
   takes the rest; the buttons then push it back as they appear. */
.sessionItem_OOQiHg:not(:where(:hover, :focus-visible, :has(:focus-visible), [data-highlighted])) .sessionActions_OOQiHg { display: none; }

.accountUsageBody_djirOA .section_JuUW3A:has(.accountRows_djirOA) { flex-direction: row; align-items: baseline; gap: 8px; }
.accountRows_djirOA { flex: 1 1 auto; min-width: 0; }
.accountRows_djirOA .accountRow_JuUW3A { justify-content: flex-start; padding: 0; }
.accountRows_djirOA .accountLabel_JuUW3A { display: none; }
.accountRows_djirOA .accountValue_JuUW3A { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.vilaus-usage-note { align-self: flex-start; padding: 0; text-align: left; white-space: normal; }
.vilaus-usage-note[hidden] { display: none; }
/* Small print, as the extension's own "Resets in 3h". */
.vilaus-usage-caveat { color: var(--app-primary-foreground); opacity: 0.5; font-size: 11px; }
[data-vilaus-usage] .accountRow_JuUW3A { cursor: default; }
[data-vilaus-usage][hidden] { display: none; }

.vilaus-provider-mark { flex: none; display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 2px; }
.sessionItem_OOQiHg > .vilaus-provider-mark { align-self: center; }
[data-vilaus-other-provider] { display: none !important; }
.vilaus-provider-filter { flex: none; justify-content: center; width: 24px; padding: 0; }
.vilaus-provider-filter > .vilaus-provider-mark { width: 10px; height: 10px; margin: 0; }
.vilaus-provider-filter[aria-pressed="true"] {
  border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
  background: var(--vscode-inputOption-activeBackground);
}

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

/* The row's controls never shrink past their icons; when the width runs out the search box
   drops its text first, then the status label and count ellipsize. */
.searchRow_OOQiHg { container-type: inline-size; }
.searchRowActions_OOQiHg { flex: 1 1 auto; flex-wrap: nowrap; }
.activeFilterToggle_OOQiHg { display: none; }
.statusFilterMenuButton_OOQiHg {
  flex: 0 1 auto;
  min-width: 24px;
  height: 24px;
  gap: 3px;
  margin-left: 0;
  padding: 0 4px;
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
  border-radius: 4px;
  overflow: hidden;
  white-space: nowrap;
}
.statusFilterMenuButton_OOQiHg > .newGroupIcon_OOQiHg { order: 0; flex-shrink: 0; }
.statusFilterMenuButton_OOQiHg[data-vilaus-label]::before {
  content: attr(data-vilaus-label);
  order: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1000;
}
.statusFilterMenuButton_OOQiHg[data-vilaus-needs-input]::after {
  content: attr(data-vilaus-needs-input);
  order: 2;
  min-width: 0;
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 25%, transparent);
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}
.statusFilterMenuButton_OOQiHg > .statusFilterCaret_OOQiHg { order: 3; }

.searchRowTail_OOQiHg { flex: 1 1 auto; min-width: 52px; margin-left: 6px; }
.searchRowTail_OOQiHg > .newGroupButton_OOQiHg:not(.searchToggleButton_OOQiHg) { gap: 0; padding: 4px; font-size: 0; }
.searchToggleButton_OOQiHg,
.searchToggleButton_OOQiHg:hover,
.searchToggleButton_OOQiHg:focus {
  flex: 1 1 auto;
  min-width: 36px;
  justify-content: flex-start;
  gap: 6px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
  background: var(--vscode-input-background);
  color: var(--vscode-input-placeholderForeground);
}
.searchToggleButton_OOQiHg:hover { border-color: var(--vscode-focusBorder); }
.searchToggleButton_OOQiHg > svg { flex-shrink: 0; }
.searchToggleButton_OOQiHg::after {
  content: attr(aria-label);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Narrow rows (the row's width, not the window's): the search box becomes a plain icon
   button like "New group", and with sessions waiting for the user the status label goes
   too, leaving its count. Both still click. */
@container (max-width: 260px) {
  .searchRow_OOQiHg:has(.statusFilterMenuButton_OOQiHg[data-vilaus-needs-input]) .statusFilterMenuButton_OOQiHg::before { display: none; }
}
@container (max-width: 370px) {
  .searchRow_OOQiHg:has(.statusFilterMenuButton_OOQiHg[data-vilaus-needs-input]) .searchToggleButton_OOQiHg,
  .searchRow_OOQiHg:has(.statusFilterMenuButton_OOQiHg[data-vilaus-needs-input]) .searchToggleButton_OOQiHg:hover,
  .searchRow_OOQiHg:has(.statusFilterMenuButton_OOQiHg[data-vilaus-needs-input]) .searchToggleButton_OOQiHg:focus {
    flex: 0 0 auto;
    width: 24px;
    min-width: 24px;
    margin-left: auto;
    padding: 0;
    border: 1px solid transparent;
    background: transparent;
    color: var(--app-secondary-foreground);
    justify-content: center;
  }
  .searchRow_OOQiHg:has(.statusFilterMenuButton_OOQiHg[data-vilaus-needs-input]) .searchToggleButton_OOQiHg:hover,
  .searchRow_OOQiHg:has(.statusFilterMenuButton_OOQiHg[data-vilaus-needs-input]) .searchToggleButton_OOQiHg:focus {
    background: var(--app-ghost-button-hover-background);
    color: var(--app-primary-foreground);
  }
  .searchRow_OOQiHg:has(.statusFilterMenuButton_OOQiHg[data-vilaus-needs-input]) .searchToggleButton_OOQiHg::after { display: none; }
}
@container (max-width: 230px) {
  .searchToggleButton_OOQiHg,
  .searchToggleButton_OOQiHg:hover,
  .searchToggleButton_OOQiHg:focus {
    flex: 0 0 auto;
    width: 24px;
    min-width: 24px;
    margin-left: auto;
    padding: 0;
    border: 1px solid transparent;
    background: transparent;
    color: var(--app-secondary-foreground);
    justify-content: center;
  }
  .searchToggleButton_OOQiHg:hover,
  .searchToggleButton_OOQiHg:focus {
    background: var(--app-ghost-button-hover-background);
    color: var(--app-primary-foreground);
  }
  .searchToggleButton_OOQiHg::after { display: none; }
}
`;

/**
 * The session list's rows (anthropic.claude-code 2.1.296): `<button id="sessions-list-row-<session id>">`,
 * with its rename and archive buttons in `.sessionActions_OOQiHg`. The shell adds a delete
 * button next to them, in the same classes.
 */
/**
 * The session list's filters (anthropic.claude-code 2.1.296): "Active · N", a toggle that shows
 * only sessions needing input, working or unread; and a button (a funnel and a caret) whose
 * menu filters by status (needs input, working, completed) and by open tabs. The shell makes
 * the second one drop-down: it shows the Active count and, while sessions wait for the user,
 * how many (styles in SESSION_LIST_STYLES; the toggle itself is hidden).
 */
const STATUS_FILTER: StatusFilterHints = {
  menuButton: '.statusFilterMenuButton_OOQiHg',
  activeToggle: '.activeFilterToggle_OOQiHg',
};

/**
 * The session list's "Account & usage" (anthropic.claude-code 2.1.296), first in `.root_djirOA`:
 * a header (a toggle with a chevron and the title, and a "View details" link), then the body
 * (sections of label / value rows). The shell's usage block is built of the same classes.
 */
const USAGE_BLOCK: UsageBlockHints = {
  root: '.root_djirOA',
  header: 'sectionHeader_djirOA',
  toggle: 'sectionToggle_djirOA',
  chevron: 'sectionChevron_djirOA',
  chevronExpanded: 'sectionChevronExpanded_djirOA',
  label: 'sectionLabel_djirOA',
  link: 'sectionLink_djirOA',
  body: 'container_JuUW3A accountUsageBody_djirOA',
  section: 'section_JuUW3A',
  rows: 'accountInfo_JuUW3A',
  row: 'accountRow_JuUW3A',
  rowLabel: 'accountLabel_JuUW3A',
  rowValue: 'accountValue_JuUW3A',
};

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
  return typeof sessionId === 'string' && sessionId.length > 0 && state.sessionWithNoTranscript !== sessionId ? sessionId : undefined;
}

/** The session a conversation panel's page shows, also a new one that has no transcript yet (see above). */
export function shownSessionId(state: unknown): string | undefined {
  const sessionId = isRecord(state) ? state.sessionID : undefined;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
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
  /** Keeps the preview panel of this webview (see `opensAsPreview`). */
  readonly pinPreview?: (webviewId: string) => void;
  /** What the window's conversations are doing changed (see `observeToWebview`). */
  readonly onActivity?: (activity: SessionActivity) => void;
  /** The window's conversations, what each is doing, or the one in front changed (for the local API). */
  readonly onConversations?: (conversations: readonly ConversationStateDto[], activeSessionId: string | undefined) => void;
  /**
   * A Claude process made its first API call on a session: the session ran under `provider`,
   * the window's provider when the process started (`at`); see `observeOutput`.
   */
  readonly onSessionUsed?: (usage: { sessionId: string; provider: string; at: number }) => void;
  /** A turn ended in a conversation: what its session cost changed. */
  readonly onTurnEnded?: (sessionId: string | undefined) => void;
  /** The window's provider at first, and whether the shell works out what conversations cost (see `setProvider`). */
  readonly provider?: string;
  readonly shellPricing?: boolean;
  /** What the window's provider cost, the conversation in front being `sessionId` (main's `usage.view`). */
  readonly usageView?: (sessionId: string | undefined) => Promise<UsageViewDto | null>;
  /** The provider of every session, for the session lists' marks (main's `usage.sessionProviders`). */
  readonly sessionProviders?: () => Promise<SessionProvidersDto>;
  /** A conversation opens a session with a history: the notice to show if it ran under another provider (main's `sessions.opened`). */
  readonly sessionOpened?: (sessionId: string) => Promise<ProviderNoticeDto | null>;
}

/** The usage block's view is asked for again at most this often. */
const USAGE_REFRESH_MS = 1000;

export class ClaudeWebviewBridge implements WebviewMessageInterceptor {
  /** `open_diff` requests we are holding, by requestId. */
  private readonly heldDiffs = new Map<string, WebviewImpl>();
  private loggedInputShape = false;
  /** Sessions open in this window's panels, and held by another process, as the extension last said. */
  private openSessions = new Set<string>();
  private elsewhereSessions = new Set<string>();
  private loggedStatesShape = false;
  /** The session list's latest open still unanswered; `preview` until it has made its panel. */
  private listOpen: { requestId: string; sessionId: string; at: number; preview: boolean } | undefined;
  /** The session the list last opened, and when: a second open soon after is a double click. */
  private lastListOpen: { sessionId: string; at: number } | undefined;
  /** The session each preview panel's webview shows, by webview id. */
  private readonly previews = new Map<string, string>();
  /** The session list's pages, and the session states they were last sent (every session open in it). */
  private readonly listPages = new Map<WebviewImpl, Record<string, unknown>>();
  /** What the bridge itself posts to pages, which it does not look at again. */
  private readonly ownPosts = new WeakSet<object>();
  /** The conversations at work and waiting, as last reported. */
  private activity: SessionActivity = { running: 0, waiting: 0 };
  /** The window's conversations as the extension last told its pages, and what was last reported of them. */
  private conversations: readonly ConversationStateDto[] = [];
  private reportedConversations = JSON.stringify([[], null]);
  /** The pages' answers to `submitPrompt` awaited, by id. */
  private readonly submits = new Map<number, (outcome: PromptSubmitOutcome) => void>();
  private nextSubmit = 1;
  /**
   * Each conversation's Claude process (by page and channel): the provider it started under and
   * when, the session it works on, and whether it made a call on that session yet.
   */
  private readonly processes = new Map<string, { provider: string; at: number; sessionId: string | undefined; used: boolean }>();
  /** The pages that show a provider notice. */
  private readonly noticed = new Set<WebviewImpl>();
  /** The window's provider: what a Claude process that starts now runs under. */
  private provider: string;
  /** Whether the shell works out what the conversations cost; the extension's own figures are then hidden. */
  private shellPricing: boolean;
  /** The conversation in front, as the extension last told its pages. */
  private activeSessionId: string | undefined;
  /** What the session lists' usage block shows (null: none), and when it was last asked for. */
  private usage: UsageViewDto | null = null;
  /** What the session lists' marks show. */
  private sessionProviderView: SessionProvidersDto | null = null;
  private usageAskedAt = 0;
  private usageTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly os: OsBackend,
    private readonly logger: ILogger,
    private readonly options: BridgeOptions,
  ) {
    this.provider = options.provider ?? 'subscription';
    this.shellPricing = options.shellPricing === true;
  }

  interceptFromWebview(webview: WebviewImpl, message: unknown): boolean {
    if (!isRecord(message)) {
      return false;
    }
    if (message.ccwReply === 'submitPrompt') {
      const reply = message as Partial<PromptSubmitReply>;
      if (typeof reply.id === 'number' && reply.outcome) {
        this.submits.get(reply.id)?.(reply.outcome);
      }
      return true;
    }
    if (message.type === 'cancel_request' && typeof message.targetRequestId === 'string') {
      return this.releaseHeldDiff(message.targetRequestId);
    }
    if (message.type === 'io_message') {
      this.logInputShapeOnce(message);
      this.attachComments(webview, message);
      // A message sent in a preview: the conversation goes on there, it is kept.
      if (this.previews.has(webview.id) && isRecord(message.message) && message.message.type === 'user') {
        this.pin(webview.id);
      }
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
      case OPEN_IN_EDITOR:
        this.noteListOpen(webview, message);
        return false;
      case 'get_session_request':
        this.noteSessionOpened(webview, message);
        return false;
      default:
        return false;
    }
  }

  /**
   * A conversation panel created while a click in the session list is being answered shows
   * the clicked session (see OPEN_IN_EDITOR): it opens as a preview. One panel per click; a
   * double click opens a panel of its own.
   */
  opensAsPreview(webview: WebviewImpl): boolean {
    const open = this.listOpen;
    if (webview.viewType !== CHAT_PANEL_VIEW_TYPE || !open?.preview || Date.now() - open.at > OPEN_TIMEOUT_MS) {
      return false;
    }
    this.listOpen = { ...open, preview: false };
    this.previews.set(webview.id, open.sessionId);
    return true;
  }

  private noteListOpen(webview: WebviewImpl, message: WebviewRequest): void {
    const sessionId = message.request.sessionId;
    if (webview.viewType !== SESSION_LIST_VIEW_TYPE || typeof sessionId !== 'string') {
      return;
    }
    const now = Date.now();
    const last = this.lastListOpen;
    const doubleClick = last !== undefined && last.sessionId === sessionId && now - last.at < DOUBLE_CLICK_MS;
    // A third click starts over.
    this.lastListOpen = doubleClick ? undefined : { sessionId, at: now };
    if (doubleClick) {
      for (const [webviewId, shown] of this.previews) {
        if (shown === sessionId) {
          this.pin(webviewId);
        }
      }
    }
    this.listOpen = { requestId: message.requestId, sessionId, at: now, preview: !doubleClick };
  }

  private pin(webviewId: string): void {
    this.options.pinPreview?.(webviewId);
    this.keepPreview(webviewId);
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
   *
   * The session list puts the sessions open here first and marks them with a dot. A session
   * in preview is left out of what it is told, so its row stays where it was clicked (and can
   * be double-clicked there) until the preview is kept.
   */
  observeToWebview(webview: WebviewImpl, message: unknown): unknown {
    if (isRecord(message) && this.ownPosts.has(message)) {
      return undefined;
    }
    if (this.shellPricing) {
      const priced = withoutExtensionCosts(message);
      if (priced !== undefined) {
        this.refreshUsage();
        return priced;
      }
    }
    const resets = usageResetsOf(message);
    if (resets) {
      // To the page's script, which shows the bars' reset times to the minute.
      const control: ShellToWebviewControl = { ccwControl: 'usageResets', resets };
      void webview.postMessage(control);
      return undefined;
    }
    const inner = isRecord(message) && message.type === 'from-extension' ? message.message : undefined;
    if (isRecord(inner) && inner.type === 'io_message') {
      this.observeOutput(webview, inner);
      return undefined;
    }
    // The session list's open is answered: panels from now on are not its.
    if (isRecord(inner) && inner.type === 'response' && this.listOpen && inner.requestId === this.listOpen.requestId) {
      this.listOpen = undefined;
    }
    const request = isRecord(inner) && inner.type === 'request' && isRecord(inner.request) ? inner.request : undefined;
    if (request?.type !== 'session_states_update') {
      return undefined;
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
    // `sessions`: `{sessionId, state, title}` of this window's conversations, `state` as each
    // one's page reports it: `waiting_input` while it asks the user (a permission, a question:
    // the list's "needs input"), `running` while Claude works or a background task runs, `idle`.
    const sessions: unknown = request.sessions;
    if (Array.isArray(sessions)) {
      const count = (state: string): number => sessions.filter((session) => isRecord(session) && session.state === state).length;
      const activity = { running: count('running'), waiting: count('waiting_input') };
      const control: ShellToWebviewControl = { ccwControl: 'needsInput', count: activity.waiting };
      void webview.postMessage(control);
      // Every page is sent the same update: report it once.
      if (activity.running !== this.activity.running || activity.waiting !== this.activity.waiting) {
        this.activity = activity;
        this.options.onActivity?.(activity);
      }
      this.conversations = conversationStates(sessions);
    }
    // Every update says which conversation is in front (`activeSessionId`, none: no session).
    const active = typeof request.activeSessionId === 'string' && request.activeSessionId ? request.activeSessionId : undefined;
    if (active !== this.activeSessionId) {
      this.activeSessionId = active;
      this.refreshUsage();
    }
    this.reportConversations();
    if (webview.viewType !== SESSION_LIST_VIEW_TYPE || !isRecord(message) || !isRecord(inner)) {
      return undefined;
    }
    const newPage = !this.listPages.has(webview);
    const told = { ...request, openSessionIds: request.openSessionIds ?? this.listPages.get(webview)?.openSessionIds };
    this.listPages.set(webview, told);
    if (newPage) {
      this.postSessionInfo(webview);
      this.refreshUsage();
    }
    const open = request.openSessionIds;
    const shown = Array.isArray(open) ? this.withoutPreviews(open) : open;
    return shown === open ? undefined : { ...message, message: { ...inner, request: { ...request, openSessionIds: shown } } };
  }

  /**
   * What Claude Code says goes to the conversation's page as it comes (anthropic.claude-code
   * 2.1.296: `{type: 'from-extension', message: {type: 'io_message', channelId, message}}`; a
   * resumed session's history comes another way). Once Claude Code has started, the extension
   * says so with `{type: 'system', subtype: 'status', launchTiming}`: the process runs under the
   * provider the window uses then (Claude Code reads its variables as it starts). Every turn
   * starts with `{type: 'system', subtype: 'init', session_id}`, each reply of the API is an
   * `{type: 'assistant', session_id}`, a turn ends with `{type: 'result'}`. A process can go on
   * with another session (a new one after /clear): its messages then name that one.
   */
  private observeOutput(webview: WebviewImpl, message: Record<string, unknown>): void {
    const output = message.message;
    if (!isRecord(output)) {
      return;
    }
    const key = `${webview.id}|${typeof message.channelId === 'string' ? message.channelId : ''}`;
    if (output.type === 'system' && output.subtype === 'status' && isRecord(output.launchTiming)) {
      this.processes.set(key, { provider: this.provider, at: Date.now(), sessionId: undefined, used: false });
      return;
    }
    const named = typeof output.session_id === 'string' && output.session_id ? output.session_id : undefined;
    if (output.type === 'result') {
      this.options.onTurnEnded?.(named ?? this.processes.get(key)?.sessionId);
      this.refreshUsage();
      return;
    }
    const isInit = output.type === 'system' && output.subtype === 'init';
    if (!isInit && output.type !== 'assistant') {
      return;
    }
    // A process whose start went unseen (an extension that does not say) runs under the provider of now.
    let process = this.processes.get(key);
    if (!process) {
      process = { provider: this.provider, at: Date.now(), sessionId: undefined, used: false };
      this.processes.set(key, process);
    }
    if (named && named !== process.sessionId) {
      process.sessionId = named;
      process.used = false;
    }
    const sessionId = process.sessionId;
    if (output.type === 'assistant' && sessionId && !process.used) {
      process.used = true;
      this.options.onSessionUsed?.({ sessionId, provider: process.provider, at: process.at });
      // The conversation goes on here: the notice has had its say.
      if (this.noticed.delete(webview)) {
        const control: ShellToWebviewControl = { ccwControl: 'providerNotice', notice: null };
        void webview.postMessage(control);
      }
    }
  }

  /**
   * A conversation's page asks for a session's history (`get_session_request`, purpose
   * `transcript_open` or none; `diff_refresh` only reloads its changes): it opens a session that
   * ran before. If that was under another provider, a notice shows above the message input,
   * unless the conversation went on here before the answer came.
   */
  private noteSessionOpened(webview: WebviewImpl, message: WebviewRequest): void {
    const { sessionId, purpose } = message.request;
    if (
      webview.viewType !== CHAT_PANEL_VIEW_TYPE ||
      typeof sessionId !== 'string' ||
      purpose === 'diff_refresh' ||
      !this.options.sessionOpened
    ) {
      return;
    }
    this.options.sessionOpened(sessionId).then(
      (notice) => {
        const used = [...this.processes].some(
          ([key, process]) => key.startsWith(`${webview.id}|`) && process.sessionId === sessionId && process.used,
        );
        if (!notice || used) {
          return;
        }
        this.noticed.add(webview);
        const control: ShellToWebviewControl = { ccwControl: 'providerNotice', notice };
        void webview.postMessage(control);
      },
      (error: unknown) => this.logger.warn('the provider notice failed', error),
    );
  }

  /** Tells of the window's conversations when they (or the one in front) changed since last told. */
  private reportConversations(): void {
    const reported = JSON.stringify([this.conversations, this.activeSessionId ?? null]);
    if (reported !== this.reportedConversations) {
      this.reportedConversations = reported;
      this.options.onConversations?.(this.conversations, this.activeSessionId);
    }
  }

  /**
   * The window's provider changed (or its prices, or which sessions the lists show): new Claude
   * processes run under `provider`; `shellPricing`: the shell works out what the conversations
   * cost (a compatible API's), the extension's figures hidden.
   */
  setProvider(provider: string, shellPricing: boolean): void {
    this.provider = provider;
    this.shellPricing = shellPricing;
    this.refreshUsage();
  }

  /** Asks main for the session lists' usage block and marks again, at most once a second (the last ask wins). */
  private refreshUsage(): void {
    if (this.usageTimer !== undefined) {
      return;
    }
    const wait = Math.max(0, this.usageAskedAt + USAGE_REFRESH_MS - Date.now());
    this.usageTimer = setTimeout(() => {
      this.usageTimer = undefined;
      this.usageAskedAt = Date.now();
      void this.askUsage();
    }, wait);
  }

  private async askUsage(): Promise<void> {
    // A session list that opens asks again.
    if (this.listPages.size === 0) {
      return;
    }
    let usage: UsageViewDto | null;
    let marks: SessionProvidersDto | null;
    try {
      [usage, marks] = await Promise.all([
        this.shellPricing && this.options.usageView ? this.options.usageView(this.activeSessionId) : null,
        this.options.sessionProviders ? this.options.sessionProviders() : null,
      ]);
    } catch (error) {
      this.logger.warn('the usage view failed', error);
      return;
    }
    const changed =
      JSON.stringify(usage) !== JSON.stringify(this.usage) || JSON.stringify(marks) !== JSON.stringify(this.sessionProviderView);
    this.usage = usage;
    this.sessionProviderView = marks;
    if (changed) {
      for (const page of this.listPages.keys()) {
        this.postSessionInfo(page);
      }
    }
  }

  /** The usage block and the sessions' providers, to a session list. */
  private postSessionInfo(page: WebviewImpl): void {
    const usage: ShellToWebviewControl = { ccwControl: 'usageView', view: this.usage };
    const marks: ShellToWebviewControl = { ccwControl: 'sessionProviders', view: this.sessionProviderView };
    void page.postMessage(usage);
    void page.postMessage(marks);
  }

  /**
   * A preview became a tab of its own, kept here (double click, message) or in the shell (its
   * tab double-clicked): the session list is told again what is open, with its session now.
   */
  keepPreview(webviewId: string): void {
    if (!this.previews.delete(webviewId)) {
      return;
    }
    for (const [page, told] of this.listPages) {
      const open = told.openSessionIds;
      const request = { ...told, openSessionIds: Array.isArray(open) ? this.withoutPreviews(open) : open };
      const message = { type: 'from-extension', message: { type: 'request', channelId: '', requestId: randomUUID(), request } };
      this.ownPosts.add(message);
      void page.postMessage(message);
    }
  }

  didDisposeWebview(webview: WebviewImpl): void {
    this.previews.delete(webview.id);
    this.listPages.delete(webview);
    this.noticed.delete(webview);
    for (const key of this.processes.keys()) {
      if (key.startsWith(`${webview.id}|`)) {
        this.processes.delete(key);
      }
    }
  }

  /** The entries of `openSessionIds` that are no session in preview. */
  private withoutPreviews(open: readonly unknown[]): unknown[] {
    const previewing = new Set(this.previews.values());
    const kept = open.filter((entry) => !sessionIdOf(entry).some((id) => previewing.has(id)));
    return kept.length === open.length ? (open as unknown[]) : kept;
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

  /**
   * Sends `text` in a conversation as the user does: the page's script puts it in the input and
   * presses Enter (see PROMPT_SUBMIT), unless the input holds other text.
   */
  submitPrompt(webview: WebviewImpl, text: string): Promise<PromptSubmitOutcome> {
    const id = this.nextSubmit++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish('noInput'), SUBMIT_TIMEOUT_MS);
      const finish = (outcome: PromptSubmitOutcome): void => {
        clearTimeout(timer);
        this.submits.delete(id);
        resolve(outcome);
      };
      this.submits.set(id, finish);
      const control: ShellToWebviewControl = { ccwControl: 'submitPrompt', id, text };
      void webview.postMessage(control);
    });
  }

  /**
   * Puts `@<path>` into a conversation's input as a mention, as the extension's own "insert
   * @-mention" does (anthropic.claude-code 2.1.306: `{type: 'request', channelId: '', requestId: '',
   * request: {type: 'insert_at_mention', text}}`; the page adds it as a chip, once, and focuses
   * the input; a path with spaces is in double quotes).
   */
  insertMention(webview: WebviewImpl, text: string): void {
    const request = { type: 'request', channelId: '', requestId: '', request: { type: 'insert_at_mention', text } };
    void webview.postMessage({ type: 'from-extension', message: request });
  }

  pageHints(webview: WebviewImpl): WebviewPageHints | undefined {
    switch (webview.viewType) {
      case CHAT_PANEL_VIEW_TYPE:
        return {
          commentsAnchor: CHAT_INPUT_FORM,
          untranslated: PAGE_CONTENT,
          styles: FONT_STYLES + ACCENT_STYLES + USAGE_STYLES + CONVERSATION_STYLES,
          meters: USAGE_METERS,
          usageBars: USAGE_BARS,
          conversationEscapes: CONVERSATION_ESCAPES,
          streamMerge: STREAM_MERGE,
          fileLinks: FILE_LINKS,
          keepInPlace: THINKING_SUMMARY,
          selectableChoices: QUESTION_OPTION,
          messageMarkers: MESSAGE_MARKERS,
          conversationComments: CONVERSATION_COMMENTS,
          promptSubmit: PROMPT_SUBMIT,
        };
      case SESSION_LIST_VIEW_TYPE:
        return {
          untranslated: PAGE_CONTENT,
          styles: FONT_STYLES + ACCENT_STYLES + USAGE_STYLES + SESSION_LIST_STYLES,
          meters: USAGE_METERS,
          sessionRows: SESSION_ROWS,
          usageBars: USAGE_BARS,
          statusFilter: STATUS_FILTER,
          usageBlock: USAGE_BLOCK,
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
      typeof inner.content === 'string'
        ? [{ type: 'text', text: inner.content }]
        : Array.isArray(inner.content)
          ? inner.content
          : undefined;
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

/**
 * `session_states_update.sessions` (anthropic.claude-code 2.1.296): `{sessionId, state, title}`
 * with `state` `running`, `waiting_input` or `idle`.
 */
export function conversationStates(sessions: readonly unknown[]): ConversationStateDto[] {
  return sessions.flatMap((session): ConversationStateDto[] => {
    if (!isRecord(session) || typeof session.sessionId !== 'string' || !session.sessionId) {
      return [];
    }
    const state = session.state === 'running' ? 'running' : session.state === 'waiting_input' ? 'waiting' : 'idle';
    return [{ sessionId: session.sessionId, title: typeof session.title === 'string' ? session.title : '', state }];
  });
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
    value.type === 'request' && typeof value.requestId === 'string' && isRecord(value.request) && typeof value.request.type === 'string'
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
