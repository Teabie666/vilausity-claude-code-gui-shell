/**
 * The single source of truth for every message that crosses a process boundary.
 *
 *   main  <--(utilityProcess port)-->  extension host  <--(MessagePort)-->  renderer
 *     ^                                                                        |
 *     +-------------------------(ipc via preload)------------------------------+
 *
 * Each `XxxApiForYyy` type lists the methods process Xxx serves to process Yyy.
 * The renderer also talks to webview iframes through window.postMessage; those
 * envelopes are defined at the bottom.
 *
 * Rule: only plain, structured-clone-safe data here (no class instances, no functions).
 */

import type { ExtensionErrorCode, ManagedExtensions } from './extensionUpdates';
import type { KeybindingEntry } from './keybindings';
import type { ApiOperationInfo, ApiParams, ApiStatusDto } from './localApi';
import type { UiLanguage, UiLanguageSetting } from './nls';
import type { ProviderConfig, ProviderSummary } from './providers';

// ---------------------------------------------------------------------------
// Shared data types
// ---------------------------------------------------------------------------

export type StorageScope = 'global' | 'workspace';

export type ThemeKind = 'vscode-dark' | 'vscode-light' | 'vscode-high-contrast' | 'vscode-high-contrast-light';

export interface ThemeData {
  /** Stable id, e.g. `dark-modern`. */
  readonly id: string;
  /** Human label, e.g. `Dark Modern`. */
  readonly label: string;
  readonly kind: ThemeKind;
  /** CSS custom properties without the leading `--`, e.g. `vscode-editor-background`. */
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * Translations of the Claude Code extension's own UI text (M3.5, see
 * platform/extensionStrings.ts). Holds no English: keys are lengths and hashes.
 */
export interface ExtensionTranslations {
  /** The extension version the table was last checked against. */
  readonly extensionVersion: string;
  /** `<length>:<hash>` of a normalized text -> its translation ("" keeps the English). */
  readonly strings: Readonly<Record<string, string>>;
  /** `<prefix length>:<suffix length>:<hash>` of a template with one variable -> its translation. */
  readonly templates: Readonly<Record<string, TemplateTranslation>>;
}

export interface TemplateTranslation {
  /** What the variable may be: digits (a count, a percentage) or any short text. */
  readonly type: 'number' | 'any';
  /** `{0}` stands for the variable ("" keeps the English). */
  readonly text: string;
}

export interface AppInfo {
  /** Reported as `vscode.env.appName`; the extension tunes behaviour per host, so we mimic VSCodium. */
  readonly appName: string;
  /** Reported as `vscode.version`. */
  readonly vscodeVersion: string;
  readonly uriScheme: string;
  /** Reported as `vscode.env.language`: the shell's display language, as VS Code does. */
  readonly language: UiLanguage;
  readonly machineId: string;
  readonly sessionId: string;
  readonly shell: string;
}

export interface ExtHostPaths {
  readonly userData: string;
  readonly logs: string;
  readonly globalStorage: string;
  readonly workspaceStorage: string;
  /** Claude Code's own folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`): the records of its processes. */
  readonly claudeConfig: string;
}

export interface ExtHostInitData {
  /** Directory that contains the Claude Code extension's package.json. */
  readonly extensionPath: string;
  readonly workspaceFolders: readonly string[];
  readonly paths: ExtHostPaths;
  /** Flat `section.key -> value` map from the user's settings file. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly globalState: Readonly<Record<string, unknown>>;
  readonly workspaceState: Readonly<Record<string, unknown>>;
  readonly logLevel: number;
  readonly app: AppInfo;
  readonly themeKind: ThemeKind;
  /** The extension UI's translations in this run's language (none for English). */
  readonly extensionTranslations?: ExtensionTranslations;
  /**
   * A conversation to open once the extension is up (the command line's --session or
   * --prompt), instead of the new one a window shows when it has none to restore.
   */
  readonly openConversation?: ConversationRequest;
  /**
   * Settings laid over the user's for this window (its API provider: the extension's
   * environment variables, no login prompt). Never written to settings.json.
   */
  readonly settingsOverlay?: Readonly<Record<string, unknown>>;
  /** The shell works out what the window's conversations cost, not the extension (`usage.changed`). */
  readonly shellPricing?: boolean;
  /** The window's API provider (its id): new Claude processes take its variables. */
  readonly provider?: string;
}

/** A conversation to open: a session to continue, and / or a prompt for it. */
export interface ConversationRequest {
  readonly sessionId?: string;
  readonly prompt?: string;
}

/** `[start, end)` of a match in a text. */
export type TextRange = readonly [number, number];

/** A search of Claude Code's sessions (their transcripts), see `sessions.search`. */
export interface SessionSearchRequest {
  /** Matched case-insensitively as one piece; empty: the latest sessions. */
  readonly query: string;
  /** Only sessions that ran in this folder; every folder's when undefined. */
  readonly folder?: string;
  readonly limit: number;
}

/** Why a session matched: its title, something said in it, or a file Claude read or changed. */
export type SessionSearchMatch =
  | { readonly kind: 'title'; readonly highlights: readonly TextRange[] }
  | {
      readonly kind: 'content';
      readonly role: 'user' | 'assistant';
      /** The passage around the match, on one line. */
      readonly text: string;
      readonly highlights: readonly TextRange[];
    }
  | {
      readonly kind: 'file';
      /** The file's path, relative to the session's folder when it is inside. */
      readonly text: string;
      readonly highlights: readonly TextRange[];
      readonly edited: boolean;
    };

export interface SessionSearchResult {
  readonly sessionId: string;
  readonly title: string;
  /** The folder the session ran in. */
  readonly folder: string;
  /** Last change, in ms since the epoch. */
  readonly updatedAt: number;
  /** Undefined for an empty query. */
  readonly match?: SessionSearchMatch;
}

/**
 * What the shell's script in a webview needs to know about the extension's page. Only the
 * bridge (host/exthost/bridge.ts) knows the extension's pages, so it supplies these; most
 * webviews have none.
 */
export interface WebviewPageHints {
  /**
   * CSS selector of the element comment blocks go right before (a conversation's message
   * input). Set for conversation panels only.
   */
  readonly commentsAnchor?: string;
  /**
   * CSS selector of the parts of the page that show content rather than the extension's own
   * UI (the conversation, names, what Claude asks), which the translation of the extension's
   * UI text leaves alone. Pages without it are not translated.
   */
  readonly untranslated?: string;
  /**
   * CSS laid over the page's own stylesheets: parts of the extension's UI in the shell's
   * look and layout (the session list in the sidebar).
   */
  readonly styles?: string;
  /**
   * CSS selector of bars whose length the page sets as an inline `width: N%` (usage meters):
   * the page script mirrors it into `--vilaus-meter` (0 to 1) on the bar, for `styles` to
   * color it by.
   */
  readonly meters?: string;
  /** The rows of a session list, where the shell adds its own row actions (delete). */
  readonly sessionRows?: SessionRowHints;
  /** The account's usage bars, whose reset time the shell shows to the minute. */
  readonly usageBars?: UsageBarHints;
  /** The session list's status filter, which the shell makes one drop-down with the "Active" count. */
  readonly statusFilter?: StatusFilterHints;
  /** A conversation page's own uses of a plain Escape, which the shell takes over (see the type). */
  readonly conversationEscapes?: ConversationEscapeHints;
  /** Where the shell's usage block goes in a session list, and the extension's classes it is built of. */
  readonly usageBlock?: UsageBlockHints;
  /** The messages a conversation page gets a token at a time, which the page script merges (see the type). */
  readonly streamMerge?: StreamMergeHints;
  /** The files a conversation page links to, which Shift+click and the right-click menu open the shell's way (see the type). */
  readonly fileLinks?: FileLinkHints;
  /**
   * CSS selector of elements kept where they are on screen for a moment after a click on one
   * changes the page around it (a thinking block's summary: every thinking block opens at once).
   */
  readonly keepInPlace?: string;
  /**
   * CSS selector of choices a click picks (a question's options) whose text `styles` makes
   * selectable, to be copied: the click that ends a selection dragged out in one does not pick it.
   */
  readonly selectableChoices?: string;
  /** A conversation's turns, for the markers by its scrollbar (see the type). */
  readonly messageMarkers?: MessageMarkerHints;
  /** A conversation's messages, whose text can be commented on (see the type). */
  readonly conversationComments?: ConversationCommentHints;
  /** Where a conversation's message input is, for the shell to send a message as Enter does (`submitPrompt`). */
  readonly promptSubmit?: PromptSubmitHints;
  /** How to tell that a conversation page leaves out a long conversation's earlier rows (see the type). */
  readonly omittedRows?: OmittedRowsHints;
  /** Changes to the page's scripts, made while a setting is on (see the type). */
  readonly scriptRewrites?: readonly ScriptRewrite[];
}

/**
 * A change to one of a page's scripts, made as main hands the page the script while a setting
 * is on; the extension's file stays as it is. The page's HTML then asks for the script with
 * its webview's id (webviewDocuments.ts), which keeps it apart from the unchanged one other
 * pages get (the browser keeps compiled scripts by their URL).
 */
export interface ScriptRewrite {
  /** The script: the end of its path, with `/` separators. */
  readonly file: string;
  /** A regular expression's source; its first match is replaced. */
  readonly find: string;
  /** What the match becomes (`$1`... as String.prototype.replace has them). */
  readonly replace: string;
  /** The setting that turns it on (true). */
  readonly setting: string;
}

/**
 * A conversation page shows a long conversation's last rows only: past `limit` rows it leaves
 * out the earliest tool calls and thinking (what Claude said and the user's messages stay). The
 * page script tells from what the page got which of Claude's messages it shows and which it
 * left out, and says so above the first turn, with a link to the full transcript.
 *
 * Messages are Claude Code's (`{type: 'assistant' | 'user', uuid, message: {content}, ...}`);
 * a message of Claude's is one content block. Only those of the conversation itself count, not
 * a subagent's (`parent_tool_use_id` set).
 */
export interface OmittedRowsHints {
  /** What hands the page a session's history: the message, and where its messages are in it. */
  readonly history: { readonly match: MessageMatch; readonly messages: MessagePath };
  /** What hands the page one more message as the conversation goes on, and where it is in it. */
  readonly live: { readonly match: MessageMatch; readonly message: MessagePath };
  /** How many rows the page shows in all; a row is a message, apart from tool results. */
  readonly limit: number;
  /** Claude's messages the page leaves out: of these content block types. */
  readonly blockTypes: readonly string[];
  /** Tool calls the page shows merged with others, or not at all, even when it leaves out none. */
  readonly unseenTools: readonly string[];
  /** The attribute Claude's messages carry their uuid in, on the page. */
  readonly uuidAttribute: string;
  /** A conversation's turns: the line goes before the first. */
  readonly turn: string;
}

export interface PromptSubmitHints {
  /** The message input (an editable element; Enter in it sends). */
  readonly input: string;
}

/**
 * How a `submitPrompt` went: sent; the input held other text (the user's, left alone); no input
 * showed up; or the page did not take the message.
 */
export type PromptSubmitOutcome = 'sent' | 'notEmpty' | 'noInput' | 'notSent';

/**
 * A page's answer to a `submitPrompt` control. It goes the way the page's messages to the
 * extension go, and the bridge takes it out.
 */
export interface PromptSubmitReply {
  readonly ccwReply: 'submitPrompt';
  readonly id: number;
  readonly outcome: PromptSubmitOutcome;
}

/** `conversation.send`: how it went, and the conversation's session (unknown for a new one at times). */
export interface ConversationSendResult {
  /** `busyElsewhere`: another process (window, VS Code, the CLI) holds the session. */
  readonly outcome: PromptSubmitOutcome | 'busyElsewhere';
  readonly sessionId?: string;
}

/**
 * A conversation's messages, for comments on their text: text selected within one gets a
 * Comment button, and the commented text is found again to highlight it and scroll to it.
 */
export interface ConversationCommentHints {
  /** A message: the user's, or one of Claude's (a reply, its thinking, a tool call). */
  readonly message: string;
  /** The attribute of Claude's messages that holds the message's uuid. */
  readonly uuidAttribute: string;
  /** Within a message, the user's own words (not the message's heading or time). */
  readonly userText: string;
  /** Within a message, Claude's thinking (not its summary line). */
  readonly thinking: string;
  /** What opens the thinking: a click on it shows every thinking block. */
  readonly thinkingToggle: string;
  /** A turn: one message of the user's and what answers it. */
  readonly turn: string;
}

/**
 * A conversation's turns, for the markers by its scrollbar: a bar for each message of the
 * user's, and a list of their first lines (the page script's `MessageMarkers`).
 */
export interface MessageMarkerHints {
  /** A turn: one message of the user's and what answers it. */
  readonly turn: string;
  /** The user's message within a turn. */
  readonly userMessage: string;
}

/** A message is the one meant when the value at each path is the one given. */
export type MessageMatch = readonly (readonly [MessagePath, string | number | boolean | null])[];

/**
 * The files a page links to: clicking one makes the page post a message that asks to open
 * it. The page script holds that message back when the shell has its own say: on a click
 * with Shift (the file opens with its program), and for the right-click menu, which it
 * learns the file for by a click it plays and keeps from the extension.
 */
export interface FileLinkHints {
  /** The elements that open a file when clicked (a click on others is never played). */
  readonly selector: string;
  /** The message a click on one posts. */
  readonly request: MessageMatch;
  /** Where the file's path is in it (as the page has it: maybe relative to the workspace). */
  readonly path: MessagePath;
}

/**
 * Messages the extension streams to a conversation page a token at a time: each adds to what
 * the one before it said (more of the reply, of a tool call's input, of the thinking, or the
 * thinking's token count). The page renders the whole conversation again for each message,
 * and fast APIs stream hundreds a second, so the page script holds a run of them and hands
 * the page one message for it: at once when anything else comes, else after a short wait.
 */
export interface StreamMergeHints {
  readonly rules: readonly StreamMergeRule[];
  /** The shortest wait before a held run goes to the page (ms); a page slow to render waits longer. */
  readonly intervalMs: number;
}

/** A path into a message, property by property from its top. */
export type MessagePath = readonly string[];

/**
 * One kind of streamed message. Two messages of a rule merge when the values at its `key`
 * paths are equal (one stream, one content block). With `append`, the merged message is the
 * first one with the text at that path concatenated; without it, the merged message is the
 * latest one, with the numbers at the `sum` paths added up.
 */
export interface StreamMergeRule {
  /** A message is the rule's when the value at each path is the one given. */
  readonly match: MessageMatch;
  readonly key: readonly MessagePath[];
  readonly append?: MessagePath;
  readonly sum?: readonly MessagePath[];
}

/**
 * The session list's top (its root element, a selector) and the classes (space-separated) of
 * the extension's "Account & usage" block, which the shell's usage block is built of.
 */
export interface UsageBlockHints {
  readonly root: string;
  readonly header: string;
  readonly toggle: string;
  readonly chevron: string;
  readonly chevronExpanded: string;
  readonly label: string;
  readonly link: string;
  readonly body: string;
  readonly section: string;
  readonly rows: string;
  readonly row: string;
  readonly rowLabel: string;
  readonly rowValue: string;
}

/** What the shell's usage block in the session list shows, in the display language. */
export interface UsageViewDto {
  /** "Usage · DeepSeek" */
  readonly title: string;
  /** How the numbers come about. */
  readonly tooltip: string;
  /** The link to the provider's prices, and its tooltip. */
  readonly editPrices: string;
  readonly editPricesTitle: string;
  /** This conversation, this workspace, all of Claude Code's sessions; `detail` by model. */
  readonly rows: readonly { readonly label: string; readonly value: string; readonly detail: string }[];
  /** The models used that have no price, as a line to show; none when every one has. */
  readonly unpriced?: string;
  /** In small print under it all: the figures can be lower than what the API charges. */
  readonly caveat: string;
}

/** What a session cost under a compatible API, for the question before it is deleted. */
export interface SessionCostDto {
  /** The provider's name. */
  readonly name: string;
  /** "¥1.23", "≥ ¥1.23" (some of its models have no price); empty when none has. */
  readonly cost: string;
}

/**
 * A compatible API's total in the providers editor: every call of Claude Code's sessions that
 * ran under it, those of sessions deleted since too.
 */
export interface UsageTotalDto {
  /** "¥12.34", "≥ ¥12.34", "—" when no model used has a price. */
  readonly value: string;
  /** By model, one line each, as the session list's usage rows tell it. */
  readonly detail: string;
}

/** The API provider of each session, for a session list's marks and its "this API only" toggle. */
export interface SessionProvidersDto {
  /** Session id -> provider id; sessions whose provider cannot be told are left out. */
  readonly sessions: Readonly<Record<string, string>>;
  /** The providers there are, with their names and accents. */
  readonly providers: Readonly<Record<string, { readonly name: string; readonly color: string }>>;
  /** The window's provider. */
  readonly current: string;
  /** Only the sessions of the window's provider show (and those whose provider cannot be told). */
  readonly onlyCurrent: boolean;
  /** The toggle's tooltip, in the display language. */
  readonly filterTitle: string;
}

/**
 * The bar above a conversation's message input when the conversation last ran under another
 * API provider than the window uses now, in the display language.
 */
export interface ProviderNoticeDto {
  readonly sessionId: string;
  readonly text: string;
  /** The provider the conversation ran under, to switch to; none when it was removed. */
  readonly switchTo?: string;
  readonly switchLabel?: string;
  readonly ignoreLabel: string;
}

/**
 * A conversation page acts on a plain Escape by itself: one that no listener prevented
 * interrupts Claude, and two in the empty message input open the rewind picker. The shell
 * makes both keybindings of its own instead: the page script prevents every plain Escape (so it
 * interrupts nothing) and keeps from the page an Escape in the empty input that would be the
 * second; the shell's `escape` control plays the page those Escapes itself.
 */
export interface ConversationEscapeHints {
  /** CSS selector of the message input. */
  readonly input: string;
  /** How close together two Escapes in the empty input open the rewind picker (ms). */
  readonly doubleMs: number;
}

/** CSS selectors of the session list's status filter button and of its "Active · N" toggle. */
export interface StatusFilterHints {
  readonly menuButton: string;
  readonly activeToggle: string;
}

/** CSS selectors of a usage bar, and within it of its label and its "Resets in 3h" text. */
export interface UsageBarHints {
  readonly bar: string;
  readonly label: string;
  readonly reset: string;
}

/** How to find a session list's rows and their action buttons. */
export interface SessionRowHints {
  /** CSS selector of a row; its element id is `idPrefix` followed by the session id. */
  readonly row: string;
  readonly idPrefix: string;
  /** CSS selector, within a row, of the session's name. */
  readonly name: string;
  /** CSS selector, within a row, of the element holding its action buttons. */
  readonly actions: string;
  /** Class names for an added button and its icon: the page's own, for the page's look. */
  readonly buttonClass: string;
  readonly iconClass: string;
}

/** The shell's text for what it adds to the extension's pages, in the display language. */
export interface WebviewLabels {
  readonly deleteSession: string;
  /** A usage bar's reset time; `{0}` is the time, e.g. "tomorrow 09:00". */
  readonly resetsAt: string;
  /** How many sessions wait for the user; `{0}` is the count. */
  readonly needsInput: string;
  /** The button by text selected in a conversation. */
  readonly comment: string;
  /** Above a conversation whose earlier rows the page leaves out ({0}: how many rows it shows). */
  readonly omittedRows: string;
  /** The link after it. */
  readonly fullTranscript: string;
  /** The display language as a BCP 47 tag, for formatting times. */
  readonly locale: string;
}

/**
 * Who uses a session: a tab of this window (closed before the session is deleted), or
 * another process (it is not deleted then).
 */
export type SessionBusy = 'open' | 'elsewhere';

/** Claude Code's own period for keeping sessions (`cleanupPeriodDays`), as Vilausity found it. */
export interface RetentionDto {
  /** In days; null when not set, or its settings.json cannot be read. */
  readonly days: number | null;
  /** Set outside Vilausity (by hand, say): it is left as it is, and the setting does not apply. */
  readonly ownValue: boolean;
  /** Claude Code's settings.json. */
  readonly file: string;
}

/** Claude Code's sessions on disk. */
export interface SessionStorageDto {
  /** Where they are (Claude Code's `projects` folder). */
  readonly folder: string;
  /** How many transcripts. */
  readonly sessions: number;
  /** Everything under the folder, what is kept next to the transcripts too. */
  readonly bytes: number;
}

/** How deleting a session went; `running`: a Claude Code process still runs it. */
export type SessionDeleteResult = 'deleted' | 'notFound' | 'running';

export interface WebviewDocument {
  readonly webviewId: string;
  /** The HTML exactly as the extension assigned it to `webview.html`. */
  readonly html: string;
  /** Absolute directories the webview may load resources from. */
  readonly resourceRoots: readonly string[];
  /** Last value passed to `setState`, restored into `getState()` on reload. */
  readonly state?: unknown;
  readonly hints?: WebviewPageHints;
}

export interface IconPathDto {
  readonly light: string;
  readonly dark: string;
}

/**
 * Where a webview panel is shown: `main` is the conversation area (VS Code's first editor
 * column), `side` the content pane (any column beside it).
 */
export type PanelArea = 'main' | 'side';

export interface PanelCreateParams {
  readonly panelId: string;
  readonly webviewId: string;
  readonly viewType: string;
  readonly title: string;
  readonly area: PanelArea;
  readonly iconPath?: IconPathDto;
  readonly preserveFocus: boolean;
  readonly retainContextWhenHidden: boolean;
  readonly enableFindWidget: boolean;
  /**
   * A conversation opened by a click in the session list, to look at: a preview, as VS Code's
   * preview editors, until it is kept (`PanelUpdateParams.pinned`, or in the shell).
   */
  readonly preview?: boolean;
}

export interface PanelUpdateParams {
  readonly panelId: string;
  readonly title?: string;
  readonly iconPath?: IconPathDto | null;
  /** A preview is kept: a message was sent in it, or its row in the session list double-clicked. */
  readonly pinned?: true;
}

/** A webview view (`registerWebviewViewProvider`), e.g. the extension's session list. */
export interface ViewCreateParams {
  readonly viewId: string;
  readonly webviewId: string;
  readonly viewType: string;
  readonly title?: string;
}

export interface ViewUpdateParams {
  readonly viewId: string;
  readonly title?: string;
  readonly description?: string;
  /** Badge count; 0 clears it. */
  readonly badge?: number;
}

export type MessageSeverity = 'info' | 'warning' | 'error';

export interface MessageRequest {
  readonly severity: MessageSeverity;
  readonly message: string;
  readonly detail?: string;
  readonly modal: boolean;
  readonly items: readonly string[];
}

export interface QuickPickItemDto {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly picked?: boolean;
  readonly separator?: boolean;
}

export interface QuickPickRequest {
  readonly items: readonly QuickPickItemDto[];
  readonly title?: string;
  readonly placeHolder?: string;
  readonly canPickMany: boolean;
}

export interface InputBoxRequest {
  readonly title?: string;
  readonly prompt?: string;
  readonly placeHolder?: string;
  readonly value?: string;
  readonly password: boolean;
  /** Shown as an error under the input: `value` failed the extension's `validateInput`. */
  readonly validationMessage?: string;
}

/** A `contributes.commands` entry of the extension's package.json. */
export interface CommandContribution {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
}

/** A `contributes.menus[menuId]` entry of the extension's package.json. */
export interface MenuItemContribution {
  readonly command: string;
  readonly when?: string;
  /** VS Code syntax: `group` or `group@order`. */
  readonly group?: string;
}

/** A setting with the JSON schema of its value, as a `contributes.configuration` property declares it. */
export interface SettingContribution {
  readonly key: string;
  /** type, default, description / markdownDescription, enum, minimum... as declared. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** The configuration's title, e.g. `Claude Code`. */
  readonly section: string;
}

/** What the extension declares in its package.json that the shell shows itself. */
export interface ExtensionContributions {
  readonly commands: readonly CommandContribution[];
  /** By menu id, e.g. `webview/context`. */
  readonly menus: Readonly<Record<string, readonly MenuItemContribution[]>>;
  readonly configuration: readonly SettingContribution[];
}

/** One entry the renderer adds to a webview's right-click menu. */
export interface ContextMenuItemDto {
  /** Sent back in the `contextMenuAction` event when the item is clicked. */
  readonly id: string;
  readonly label: string;
}

/** An item of a menu the renderer has main show (`window.popupMenu`); without an id, a separator. */
export interface PopupMenuItemDto {
  readonly id?: string;
  readonly label?: string;
}

// ---- documents and editors (the content pane) ----
//
// Documents shown in an editor ("attached") are owned by the renderer's text model: the
// extension host mirrors them from `document.didChange`, and asks the renderer to apply
// its own edits. See docs/ARCHITECTURE.md ("文档和编辑器").

/**
 * A file's text on disk, read-only, whatever its editor holds (the file URI with this
 * scheme): the left side of "Compare Active File with Saved".
 */
export const SAVED_FILE_SCHEME = 'vilaus-saved';

/** 0-based, like `vscode.Position`. */
export interface PositionDto {
  readonly line: number;
  readonly character: number;
}

export interface RangeDto {
  readonly start: PositionDto;
  readonly end: PositionDto;
}

export interface SelectionDto {
  readonly anchor: PositionDto;
  readonly active: PositionDto;
}

export interface DocumentSnapshot {
  /** `vscode.Uri.toString()`: the document's identity on both sides. */
  readonly uri: string;
  /** `fsPath` for file URIs, else the URI path; for labels and tooltips. */
  readonly path: string;
  readonly text: string;
  readonly languageId: string;
  readonly isDirty: boolean;
  readonly readOnly: boolean;
}

/** One change of a `document.didChange`, against the text before that event. */
export interface TextChangeDto {
  readonly range: RangeDto;
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

export interface TextEditDto {
  readonly range: RangeDto;
  readonly text: string;
}

/** `vscode.TextEditorRevealType`, by name. */
export type RevealType = 'default' | 'center' | 'centerIfOutside' | 'top';

export interface ShowTextEditorParams {
  /** The tab and editor ids the extension host assigned (`TabImpl`, `TextEditor`). */
  readonly tabId: string;
  readonly editorId: string;
  readonly document: DocumentSnapshot;
  readonly preserveFocus: boolean;
  /** A preview tab is replaced by the next preview, until it is edited or pinned. */
  readonly preview: boolean;
  readonly selection?: RangeDto;
}

/** A button above a diff that runs an extension command (with the diff tab made active first). */
export interface DiffActionDto {
  readonly command: string;
  readonly kind: 'accept' | 'reject';
}

export interface ShowDiffEditorParams {
  readonly tabId: string;
  readonly title: string;
  readonly original: DocumentSnapshot;
  readonly modified: DocumentSnapshot;
  readonly originalEditorId: string;
  readonly modifiedEditorId: string;
  readonly preserveFocus: boolean;
  readonly actions: readonly DiffActionDto[];
}

// ---- comments ----
//
// Comments on selected text (in the content pane, or in the conversation itself) belong to a
// conversation (by its webview) until the next message, which carries them. The extension host
// keeps them (the bridge needs them when a message goes out); the renderer adds, edits and
// shows them.

export type CommentDto = FileCommentDto | ConversationCommentDto;

interface CommentBaseDto {
  readonly id: string;
  /** The text the comment is about, as selected. */
  readonly quote: string;
  readonly text: string;
}

/** On text of a document. (Comments saved before conversation comments existed have no `kind`.) */
export interface FileCommentDto extends CommentBaseDto {
  readonly kind?: 'file';
  /** The document it was selected in (`vscode.Uri.toString()`), and the file's path. */
  readonly uri: string;
  readonly path: string;
  /** Where in that document; for a rendered view (Markdown preview), the lines it came from. */
  readonly range: RangeDto;
}

/** On text of the conversation the comment goes to. */
export interface ConversationCommentDto extends CommentBaseDto {
  readonly kind: 'conversation';
  readonly place: ConversationPlaceDto;
}

/** Where text of a conversation is, as its page showed it (see ConversationCommentHints). */
export interface ConversationPlaceDto {
  /** Whose words: one of Claude's messages (a reply, a tool call), its thinking, or the user's own message. */
  readonly role: 'reply' | 'thinking' | 'user';
  /** Claude's message's uuid (the page shows none for the user's). */
  readonly uuid?: string;
  /** Which turn of the conversation it is in (0-based): finds the user's message, and the nearest repeat of the text. */
  readonly turn: number;
  /** Where the quote starts in the message's text, to tell repeats of it apart. */
  readonly offset: number;
}

/** Text of a conversation that a comment is about. */
export interface ConversationQuoteDto {
  readonly quote: string;
  readonly place: ConversationPlaceDto;
}

/** Text selected in a conversation page, to comment on. */
export interface ConversationSelectionDto extends ConversationQuoteDto {
  /** The end of the selection (its last line's box) in the page, where the shell opens its form. */
  readonly rect: RectDto;
}

export interface RendererInitData {
  readonly theme: ThemeData;
  readonly workspaceFolders: readonly string[];
  readonly appVersion: string;
  /** What the app runs on, for the About section's Copy Version Information (`os`: type, arch, release). */
  readonly runtimeVersions: { readonly electron: string; readonly chromium: string; readonly node: string; readonly os: string };
  /** The display language for this run; a change takes a restart. */
  readonly language: UiLanguage;
  readonly providers: ProvidersState;
  /** The administrator instance (elevated): the title bar says so. */
  readonly elevated: boolean;
  /** The user's home folder: as a workspace, it stands for the whole computer. */
  readonly homeFolder: string;
}

/** The latest release on GitHub, as the About section shows it (pre-releases count). */
export interface LatestReleaseDto {
  /** Without the tag's `v`. */
  readonly version: string;
  readonly url: string;
  readonly publishedAt?: string;
}

/** The latest release, or that GitHub could not be asked (Retry asks again). */
export type LatestReleaseResult = { readonly ok: true; readonly release: LatestReleaseDto } | { readonly ok: false };

/** What the extension updater is doing. */
export type ExtensionActivity =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'downloading'; readonly version: string; readonly received: number; readonly total?: number }
  /** `label`: the version, or the name of the .vsix file. */
  | { readonly kind: 'installing'; readonly label: string }
  /** Copying another editor's copy into the store, to go back to it later. */
  | { readonly kind: 'backingUp'; readonly version: string };

/** How a check for updates, or installing a .vsix, ended. */
export type ExtensionInstallResult =
  /** `version`: the newest Open VSX offers (or the pinned one), already in use or pending. */
  | { readonly outcome: 'upToDate'; readonly version: string }
  /** `version` is pending: it is used from the next start. */
  | { readonly outcome: 'installed'; readonly version: string }
  | { readonly outcome: 'failed'; readonly code: ExtensionErrorCode; readonly message: string }
  /** The user closed the file picker. */
  | { readonly outcome: 'cancelled' };

/** The Claude Code extension: the copy the windows run, the managed copies, updates. */
export interface ExtensionStatus {
  /** Undefined when none was found. */
  readonly running?: { readonly version: string; readonly path: string; readonly kind: 'cli' | 'managed' | 'external' };
  readonly managed: ManagedExtensions;
  readonly activity: ExtensionActivity;
  /**
   * The version Go Back returns to: the previous managed one, or (when there is none, as
   * after the first update) another editor's older copy, which is backed up first.
   */
  readonly rollback?: { readonly version: string; readonly from: 'managed' | 'external'; readonly path: string };
  /** The last check for updates in this run, automatic or not. */
  readonly lastCheck?: ExtensionInstallResult & { readonly at: number; readonly manual: boolean };
  /** False with `--extension-dir`: that copy is used as it is, and nothing is updated. */
  readonly updatesApply: boolean;
}

/** What the page shows once, at the first start that finds it. */
export interface StartupNotices {
  /** Git for Windows is not on PATH (Claude then runs commands in PowerShell). */
  readonly gitMissing: boolean;
}

/**
 * What a window's conversations are doing, as their pages tell the extension: how many have
 * Claude at work, and how many wait for the user (a permission, a question).
 */
export interface SessionActivity {
  readonly running: number;
  readonly waiting: number;
}

/**
 * What a conversation is doing: Claude at work (or a background task running), waiting for
 * the user (a permission, a question), or neither.
 */
export type ConversationState = 'running' | 'waiting' | 'idle';

/** One of a window's conversations, as its page tells the extension. */
export interface ConversationStateDto {
  readonly sessionId: string;
  readonly title: string;
  readonly state: ConversationState;
}

/** The API providers (without keys) and the one this window uses. */
export interface ProvidersState {
  readonly providers: readonly ProviderSummary[];
  readonly current: string;
}

// ---------------------------------------------------------------------------
// main <-> extension host
// ---------------------------------------------------------------------------

/** Served by main, called by the extension host. */
export type MainApiForExtHost = {
  'exthost.activated': (p: { extensionVersion: string }) => void;
  'exthost.activationFailed': (p: { message: string; stack?: string }) => void;
  'webview.setDocument': (p: WebviewDocument) => void;
  'webview.releaseDocument': (p: { webviewId: string }) => void;
  'os.openExternal': (p: { url: string }) => boolean;
  'os.clipboardRead': (p: void) => string;
  'os.clipboardWrite': (p: { text: string }) => void;
  /** Shows a file or folder selected in the system's file manager (`revealFileInOS`). */
  'os.revealFile': (p: { path: string }) => void;
  /** `value: undefined` deletes the key. */
  'storage.set': (p: { scope: StorageScope; key: string; value: unknown }) => void;
  /** `value: undefined` removes the setting. */
  'settings.set': (p: { key: string; value: unknown }) => void;
  /** The window's conversations started or stopped working or waiting (the taskbar button and the title bar's logo show it). */
  'sessions.activity': (p: SessionActivity) => void;
  /** The window's conversations, or what one of them is doing, changed; `activeSessionId`: the one in front. */
  'sessions.states': (p: { conversations: readonly ConversationStateDto[]; activeSessionId?: string }) => void;
  /**
   * A Claude process made its first API call on a session: the session ran under `provider`
   * from `at` (when the process started; Claude Code reads its variables then).
   */
  'sessions.used': (p: { sessionId: string; provider: string; at: number }) => void;
  /** A conversation opens a session that has a history: whether to warn that it ran under another provider. */
  'sessions.opened': (p: { sessionId: string }) => ProviderNoticeDto | null;
  /** The provider of every session, for the session lists. */
  'usage.sessionProviders': (p: void) => SessionProvidersDto;
  /**
   * What the window's provider cost (`sessionId` the conversation in front), for the session
   * list's usage block; null when the shell does not work that out for this provider.
   */
  'usage.view': (p: { sessionId?: string }) => UsageViewDto | null;
};

/** Served by the extension host, called by main. The `init` call carries the renderer port. */
export type ExtHostApiForMain = {
  init: (p: ExtHostInitData) => void;
  'settings.didChange': (p: { settings: Readonly<Record<string, unknown>>; keys: readonly string[] }) => void;
  /** The window's settings overlay changed (another API provider, or the same one edited). */
  'settings.overlay': (p: { values: Readonly<Record<string, unknown>> }) => void;
  /**
   * Another window's extension host changed a stored value. Global state is shared by all
   * windows (VS Code syncs `globalState` across windows too); `value: undefined` deleted it.
   */
  'storage.didChange': (p: { scope: StorageScope; key: string; value: unknown }) => void;
  /** Opens a conversation once the extension is active (the command line's --session / --prompt). */
  'conversation.open': (p: ConversationRequest) => void;
  /** Sends `prompt` in the session's conversation (opened if need be), or in a new one, as Enter does (the local API). */
  'conversation.send': (p: { sessionId?: string; prompt: string }) => ConversationSendResult;
  /** Opens a file in the content pane (the command line's --goto); false if it cannot be read. */
  'documents.show': (p: { uri: string; selection?: RangeDto }) => boolean;
  /** A `vilaus://<extension id>/...` link from outside, for the extension's URI handler; asks the user first. */
  'uri.handle': (p: { uri: string }) => void;
  /** Sessions were deleted: the extension's pages list them again. */
  'sessions.storeChanged': (p: void) => void;
  /**
   * The window's provider, or its prices, changed: whether the shell works out what the
   * conversations cost (a compatible API) and the session list shows its usage block.
   */
  'usage.changed': (p: { shellPricing: boolean; provider: string }) => void;
  shutdown: (p: void) => void;
};

// ---------------------------------------------------------------------------
// renderer <-> extension host
// ---------------------------------------------------------------------------

/** Served by the extension host, called by the renderer. */
export type ExtHostApiForRenderer = {
  /** The renderer has wired the port and can receive panels. */
  'renderer.ready': (p: void) => void;
  'webview.didLoad': (p: { webviewId: string }) => void;
  'webview.didReceiveMessage': (p: { webviewId: string; message: unknown }) => void;
  'webview.didUpdateState': (p: { webviewId: string; state: unknown }) => void;
  'panel.didChangeViewState': (p: { panelId: string; active: boolean; visible: boolean }) => void;
  /** The user closed a panel's tab in the shell. */
  'panel.didClose': (p: { panelId: string }) => void;
  /** A preview (`PanelCreateParams.preview`) became a tab of its own in the shell. */
  'panel.didPin': (p: { panelId: string }) => void;
  /**
   * The shell wants to show the view registered under `viewType`. Resolves to false when
   * the extension registered no provider for it.
   */
  'view.resolve': (p: { viewType: string }) => boolean;
  'view.didChangeVisibility': (p: { viewId: string; visible: boolean }) => void;
  'commands.execute': (p: { id: string; args: readonly unknown[] }) => unknown;
  /** Read from the manifest, so it does not wait for activation. */
  'extension.contributions': (p: void) => ExtensionContributions;
  /** Whether a session is in use (as the extension last told its pages); undefined when not. */
  'sessions.busy': (p: { sessionId: string }) => SessionBusy | undefined;
  /** The session lists show only the sessions active in the last `days` days (0: all). */
  'sessions.showWithin': (p: { days: number }) => void;
  /** The archived sessions of the window's folder, as the session list was last told them. */
  'sessions.archived': (p: void) => string[];
  /**
   * Closes the tabs that show a session (before it is deleted, or opened under another
   * provider); the extension then ends its Claude process. Resolves to how many were closed,
   * once that process has ended (or after a while, if it does not).
   */
  'sessions.close': (p: { sessionId: string }) => number;

  // ---- documents and editors ----
  /** The shell opens a file (quick open, drop...); answered by `editor.showText`. False if it cannot be read. */
  'documents.show': (p: { uri: string; preserveFocus: boolean; preview: boolean; selection?: RangeDto }) => boolean;
  /** Workspace files for quick open, relative to the first folder with `/` separators. */
  'documents.listFiles': (p: { maxResults: number }) => string[];
  'document.didChange': (p: { uri: string; changes: readonly TextChangeDto[]; isUndoing: boolean; isRedoing: boolean }) => void;
  'document.didChangeDirty': (p: { uri: string; isDirty: boolean }) => void;
  /** Saves the attached document (fires will-save and did-save). False when it cannot be saved. */
  'document.save': (p: { uri: string }) => boolean;
  /** Discards unsaved changes: answered by `document.reload` with the text on disk. */
  'document.revert': (p: { uri: string }) => void;
  'editor.didChangeSelection': (p: { editorId: string; selections: readonly SelectionDto[] }) => void;
  /**
   * Which editors the user sees: `visible` are the editors of the active content tab while
   * the content pane is shown, `active` the one among them that takes input.
   */
  'editor.didChangeVisible': (p: { active: string | undefined; visible: readonly string[] }) => void;
  /** A content tab became the active one (also makes its tab group the active group). */
  'tab.didActivate': (p: { tabId: string }) => void;
  /** The user closed a text or diff tab. */
  'tab.didClose': (p: { tabId: string }) => void;

  // ---- conversations ----
  /** Puts `text` (`@<path>`) into a conversation's input as a mention of a file. */
  'conversation.insertMention': (p: { webviewId: string; text: string }) => void;
  /** Opens a new conversation (with `prompt` in its input). */
  'conversation.open': (p: ConversationRequest) => void;

  // ---- comments (answered by `comments.didChange`) ----
  'comments.add': (p: { webviewId: string; comment: CommentDto }) => void;
  'comments.update': (p: { webviewId: string; id: string; text: string }) => void;
  'comments.remove': (p: { webviewId: string; ids: readonly string[] }) => void;
};

/** Served by the renderer, called by the extension host. */
export type RendererApiForExtHost = {
  'panel.create': (p: PanelCreateParams) => void;
  'panel.update': (p: PanelUpdateParams) => void;
  'panel.reveal': (p: { panelId: string; preserveFocus: boolean }) => void;
  'panel.dispose': (p: { panelId: string }) => void;
  'view.create': (p: ViewCreateParams) => void;
  'view.update': (p: ViewUpdateParams) => void;
  'view.reveal': (p: { viewId: string; preserveFocus: boolean }) => void;
  'view.dispose': (p: { viewId: string }) => void;
  'webview.load': (p: { webviewId: string; url: string }) => void;
  'webview.postMessage': (p: { webviewId: string; message: unknown }) => void;
  /** Resolves to the index of the chosen item, or undefined if dismissed. */
  'ui.showMessage': (p: MessageRequest) => number | undefined;
  /** Resolves to the indexes of the chosen items, or undefined if dismissed. */
  'ui.showQuickPick': (p: QuickPickRequest) => number[] | undefined;
  'ui.showInputBox': (p: InputBoxRequest) => string | undefined;
  /** Whether the extension may open a link that came from outside (a vilaus:// URL). */
  'ui.confirmOpenUri': (p: { uri: string; extensionName: string }) => boolean;

  // ---- documents and editors ----
  /** Opens (or activates) a text tab in the content pane. */
  'editor.showText': (p: ShowTextEditorParams) => void;
  'editor.showDiff': (p: ShowDiffEditorParams) => void;
  'editor.setSelections': (p: { editorId: string; selections: readonly SelectionDto[] }) => void;
  'editor.revealRange': (p: { editorId: string; range: RangeDto; revealType: RevealType }) => void;
  /** The extension closed a content tab (`tabGroups.close`). */
  'tab.close': (p: { tabId: string }) => void;
  /** Applies edits to an attached document; they come back as `document.didChange`. */
  'document.applyEdits': (p: { uri: string; edits: readonly TextEditDto[] }) => boolean;
  /** Replaces an attached document's text with what is on disk and marks it saved. */
  'document.reload': (p: { uri: string; text: string }) => void;
  /** An attached document was saved (also when the extension saved it). */
  'document.didSave': (p: { uri: string }) => void;
  /** An attached document with unsaved changes changed on disk. */
  'document.didChangeOnDisk': (p: { uri: string }) => void;

  /** A conversation's comments, oldest first: added, edited, removed, sent or restored. */
  'comments.didChange': (p: { webviewId: string; comments: readonly CommentDto[] }) => void;

  // ---- built-in VS Code commands the extension runs ----
  /** `vscode.openFolder`: no folder asks for one; not `newWindow` replaces this window's folder. */
  'workspace.openFolder': (p: { folder?: string; newWindow: boolean }) => void;
  /** `workbench.action.openSettings`, with the search box filled in. */
  'workbench.openSettings': (p: { query?: string }) => void;
};

// ---------------------------------------------------------------------------
// renderer <-> main (through the preload bridge)
// ---------------------------------------------------------------------------

export interface ThemeSummary {
  readonly id: string;
  readonly label: string;
  readonly kind: ThemeKind;
}

/** Served by main, called by the renderer. */
export type MainApiForRenderer = {
  'app.getInitData': (p: void) => RendererInitData;
  'app.listThemes': (p: void) => ThemeSummary[];
  /** Switches the theme, persists it in settings, and returns the full theme data. */
  'app.setTheme': (p: { id: string }) => ThemeData;
  /** Restarts the extension host after a crash. */
  'app.restartExtensionHost': (p: void) => void;
  /** The `vilaus.language` setting and the language this run shows. */
  'app.getLanguage': (p: void) => { setting: UiLanguageSetting; running: UiLanguage };
  /** Saves `vilaus.language`; main answers with `languageChanged` if a restart is needed. */
  'app.setLanguage': (p: { setting: UiLanguageSetting }) => void;
  /** Quits and starts again with every open window (their conversations are restored). */
  'app.relaunch': (p: void) => void;
  /** Closes every window; they all open again at the next start. */
  'app.quit': (p: void) => void;
  /** Notices to show once; the first window to ask gets them. */
  'app.startupNotices': (p: void) => StartupNotices;
  /** The latest release on GitHub; `force` skips the hour-long cache (the About section's Retry). */
  'app.latestRelease': (p: { force?: boolean }) => LatestReleaseResult;
  'os.openExternal': (p: { url: string }) => boolean;
  /** A system notification; also flashes the taskbar button. Only shown while unfocused. */
  'os.notify': (p: { title: string; body: string }) => void;
  /** The user's settings (flat `section.key -> value`) and where settings.json is. */
  'settings.read': (p: void) => { values: Record<string, unknown>; filePath: string };
  /** Writes one setting to settings.json; `value: undefined` removes it (back to the default). */
  'settings.update': (p: { key: string; value: unknown }) => void;
  /** The entries of keybindings.json that can take effect, and where the file is. */
  'keybindings.read': (p: void) => { entries: KeybindingEntry[]; filePath: string };
  /** Takes the entries equal to `remove` out of keybindings.json and appends `add`. */
  'keybindings.edit': (p: { remove: readonly KeybindingEntry[]; add: readonly KeybindingEntry[] }) => void;
  /** Opens a folder in the system's file manager. */
  'os.openFolder': (p: { path: string }) => void;
  /** Opens a file with its program (a folder in the file manager); false when it could not. */
  'os.openPath': (p: { path: string }) => boolean;
  /** Shows a file or folder selected in the system's file manager. */
  'os.revealPath': (p: { path: string }) => void;
  /** What is at a path: a file, a folder, or nothing. */
  'os.pathKind': (p: { path: string }) => 'file' | 'folder' | undefined;
  'os.clipboardWrite': (p: { text: string }) => void;
  /** Opens a terminal in a folder (host/main/terminal.ts); false when it could not be started. */
  'os.openTerminal': (p: { folder: string }) => boolean;
  /**
   * Files and folders to mention in a conversation, by their place in the workspace `folder`:
   * those outside it are copied into its `subfolder` first (host/main/attachments.ts).
   */
  'files.placeInWorkspace': (p: { paths: readonly string[]; folder: string; subfolder: string }) => {
    placed: string[];
    failed: string[];
  };
  'window.toggleDevTools': (p: void) => void;
  /** Asks for a folder with the system's folder picker; undefined when cancelled. */
  'window.pickFolder': (p: void) => string | undefined;
  /**
   * Opens a folder in a new window, or (`newWindow: false`) in place of the calling window's
   * workspace. A folder some window already shows just brings that window to the front.
   * False when the folder does not exist (it leaves the recent folders).
   */
  'window.openFolder': (p: { folder: string; newWindow: boolean }) => boolean;
  /** Recently opened folders, most recent first. */
  'window.recentFolders': (p: void) => string[];
  /**
   * Claude Code sessions whose title, conversation or files match, best first; with an
   * empty query the latest. Read from the transcripts under ~/.claude/projects.
   */
  'sessions.search': (p: SessionSearchRequest) => SessionSearchResult[];
  /**
   * Opens a session in its folder's window (brought forward, or opened); a tab that shows
   * it already comes to the front. False when the folder no longer exists.
   */
  'sessions.open': (p: { folder: string; sessionId: string }) => boolean;
  /** Whether File Explorer's "Open with Vilausity" entries are there (for this Windows user). */
  'explorerMenu.get': (p: void) => boolean;
  /** Adds or removes them; resolves to whether they are there now. */
  'explorerMenu.set': (p: { enabled: boolean }) => boolean;
  /**
   * Deletes a session for good: its transcript and the folders Claude Code keeps next to it.
   * Waits a while for a Claude process that still runs it to end (a tab just closed), and
   * deletes nothing if one does not. Its calls stay in the usage ledger (an API's total).
   * Every window's session list hears of it.
   */
  'sessions.delete': (p: { sessionId: string }) => SessionDeleteResult;
  /**
   * Writes a session's whole transcript as a Markdown file (the conversation page leaves out a
   * long conversation's earlier tool calls and thinking); no `sessionId`: the conversation in
   * front. The file's path, or null when there is no such session.
   */
  'sessions.fullTranscript': (p: { sessionId?: string }) => string | null;
  /** Claude Code's `cleanupPeriodDays` as it is now (brought in line with the setting first). */
  'sessions.retention': (p: void) => RetentionDto;
  /** How much room Claude Code's sessions take on disk. */
  'sessions.storage': (p: void) => SessionStorageDto;
  /** The folders the open windows show (the calling window's too). */
  'window.shownFolders': (p: void) => string[];
  /** Closes the calling window; closing the last one quits. */
  'window.close': (p: void) => void;
  /**
   * Starts the administrator instance (elevated) on a folder: Windows asks the user to
   * confirm. Resolves once the request is handed to Windows (or was refused).
   */
  'window.openFolderAsAdministrator': (p: { folder: string }) => void;
  /**
   * Reloads the calling window with a new extension host: its conversations come back
   * with new Claude processes (which then use the window's current API provider).
   */
  'window.reload': (p: void) => void;

  // ---- API providers (keys go to main and never come back) ----
  /** Makes the calling window use another provider; new conversations use it. */
  'providers.select': (p: { id: string }) => void;
  /** Adds a provider or replaces the one with its id. */
  'providers.save': (p: { provider: ProviderConfig }) => ProviderSummary;
  /** Windows that used it switch to the subscription. */
  'providers.remove': (p: { id: string }) => void;
  /** Stores the key encrypted; no key removes it. */
  'providers.setKey': (p: { id: string; key?: string }) => void;
  /** A desktop shortcut that starts Vilausity with this provider; resolves to its path. */
  'providers.createShortcut': (p: { id: string }) => string;
  /** The models Claude Code's sessions used under a provider (`modelKey`), for its prices. */
  'usage.models': (p: { providerId: string }) => string[];
  /** What a session cost under each compatible API it ran under (asked before deleting it). */
  'usage.sessionCost': (p: { sessionId: string }) => SessionCostDto[];
  /** A compatible API's total, deleted sessions included; null for another type of provider. */
  'usage.total': (p: { providerId: string }) => UsageTotalDto | null;
  /**
   * Opens a session again in the calling window, once the Claude process that ran it has ended
   * (its tab was just closed); false when it does not end in time.
   */
  'sessions.reopen': (p: { sessionId: string }) => boolean;

  // ---- The Claude Code extension (vilaus's managed copies) ----
  'extension.status': (p: void) => ExtensionStatus;
  /** Checks Open VSX now and installs a newer (or the pinned) version, even one rolled back from. */
  'extension.check': (p: void) => ExtensionInstallResult;
  /** Picks a .vsix with the system's file picker and installs it. */
  'extension.installFile': (p: void) => ExtensionInstallResult;
  /** Back to the previous version at the next start (`installed`: that version is pending). */
  'extension.rollBack': (p: void) => ExtensionInstallResult;
  /** The chords main should intercept and send back as `keybinding` events. */
  'window.setKeybindings': (p: { chords: readonly string[] }) => void;
  /** `delta` in zoom steps, or 0 to reset. Returns the new zoom level. */
  'window.zoom': (p: { delta: number }) => number;
  /**
   * The items main appends to the right-click menu inside one webview, in groups (a
   * separator between groups). No groups removes them.
   */
  'window.setWebviewMenu': (p: { webviewId: string; groups: readonly (readonly ContextMenuItemDto[])[] }) => void;
  /** Shows a menu where the mouse is; the id of the item chosen, undefined when it closed without one. */
  'window.popupMenu': (p: { items: readonly PopupMenuItemDto[] }) => string | undefined;

  // ---- the local API (platform/localApi.ts) ----
  /** Whether it serves and where; changes come as `apiStatus`. */
  'api.status': (p: void) => ApiStatusDto;
  /** The operations the page's modules offer (all of them, each time they change). */
  'api.operations': (p: { operations: readonly ApiOperationInfo[] }) => void;
  /** The answer to an `apiRequest`. */
  'api.respond': (p: { id: number; result?: unknown; error?: ApiErrorDto }) => void;
  /** An event for the API's event stream, from one of the page's modules. */
  'api.emit': (p: { name: string; data: unknown }) => void;
};

/** An operation's failure, as the page reports it (see `ApiError`). */
export interface ApiErrorDto {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** Events main pushes to the renderer (through the preload, as window messages). */
export type MainEventsForRenderer = {
  keybinding: { readonly chord: string };
  /** The mouse's back or forward button was pressed over the window. */
  navigate: { readonly direction: 'back' | 'forward' };
  extensionHostState: { readonly state: 'running' | 'crashed'; readonly detail?: string };
  /** What the window's conversations are doing changed; a page that loads starts with none at work. */
  sessionActivity: SessionActivity;
  /** The theme changed (picked in the shell, or theme/font settings edited by hand). */
  themeChanged: ThemeData;
  /** The user clicked an item registered with `window.setWebviewMenu`. */
  contextMenuAction: { readonly webviewId: string; readonly id: string };
  /** Settings now ask for another display language than this run shows; it applies on restart. */
  languageChanged: { readonly language: UiLanguage };
  /** settings.json changed (from the shell or by hand): all values, and the keys that changed. */
  settingsChanged: { readonly values: Readonly<Record<string, unknown>>; readonly keys: readonly string[] };
  /** keybindings.json changed (from the shell or by hand). */
  keybindingsChanged: { readonly entries: readonly KeybindingEntry[] };
  /** The extension's UI text is translated with this table now (null: it is not). */
  extensionTranslationsChanged: { readonly translations: ExtensionTranslations | null };
  /** Providers were added, edited or removed, or the window uses another one. */
  providersChanged: ProvidersState;
  /** The extension's status changed (a check, a download's progress, an install). */
  extensionStatus: ExtensionStatus;
  /**
   * An automatic update installed `version`, used from the next start. Sent to the most
   * recently focused window only.
   */
  extensionUpdated: { readonly version: string };
  /** A program calls one of the page's operations (`api.operations`); answered with `api.respond`. */
  apiRequest: { readonly id: number; readonly name: string; readonly params: ApiParams };
  /** The local API started, stopped or failed to start. */
  apiStatus: ApiStatusDto;
};

export interface MainEventMessage<K extends keyof MainEventsForRenderer = keyof MainEventsForRenderer> {
  readonly type: typeof IpcChannel.Event;
  readonly name: K;
  readonly payload: MainEventsForRenderer[K];
}

/**
 * `window.open('about:blank', name)` with a name starting with this opens an auxiliary
 * window: a content pane tab moved out of the main window (main allows only these).
 */
export const AUX_WINDOW_NAME_PREFIX = 'vilaus-aux-';

/** IPC channel names used by the preload bridge. */
export const IpcChannel = {
  /** renderer -> main request/response, carries an RPC envelope. */
  Rpc: 'vilaus:rpc',
  /** main -> renderer, transfers the extension host MessagePort. */
  ExtHostPort: 'vilaus:exthost-port',
  /** main -> renderer events (MainEventsForRenderer). */
  Event: 'vilaus:event',
} as const;

// ---------------------------------------------------------------------------
// renderer <-> webview iframes (window.postMessage)
// ---------------------------------------------------------------------------

/** Data the shell injects into each webview document before the extension's scripts run. */
export interface WebviewBootstrapData {
  readonly webviewId: string;
  readonly state: unknown;
  readonly theme: ThemeData;
  readonly hints?: WebviewPageHints;
  /** Shows the extension's UI text in the display language (pages with `hints.untranslated` only). */
  readonly translations?: ExtensionTranslations;
  /** The shell's @font-face rules (the bundled fonts), for the page's own styles to use. */
  readonly fontFaces?: string;
  /** Text of what the shell adds to the page (pages with `hints.sessionRows`). */
  readonly labels?: WebviewLabels;
}

/** An element's box in a webview's viewport, in CSS pixels. */
export interface RectDto {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** One comment block as a webview shows it; the shell has already made every text final. */
export interface CommentBlockDto {
  readonly id: string;
  /** The quoted text, already shortened. */
  readonly quote: string;
  /** `sample.ts:12`, with the whole path as its tooltip. */
  readonly source: string;
  readonly sourceTitle: string;
  readonly text: string;
}

/** The comments above a conversation's input, ready to render. */
export interface CommentsViewDto {
  /** Newest first: new blocks stack on top, the oldest sits right above the input. */
  readonly blocks: readonly CommentBlockDto[];
  /** Whether they start folded into the header (there are many) until the user unfolds them. */
  readonly collapsed: boolean;
  /** The conversation's own text that comments are on, highlighted faintly until they go out. */
  readonly quotes: readonly ConversationQuoteDto[];
  readonly labels: {
    /** E.g. `3 comments`. */
    readonly header: string;
    /** What happens to them, e.g. `Sent with your next message`. */
    readonly hint: string;
    readonly edit: string;
    readonly remove: string;
    readonly clear: string;
    readonly expand: string;
    readonly collapse: string;
  };
}

/** What the comment blocks in a webview report to the shell. */
export type CommentsHostEvent =
  /** The blocks found their place above the input (or lost it); the shell shows them itself meanwhile. */
  | { readonly type: 'attached'; readonly attached: boolean }
  /** `rect`: the block, where the shell opens its editor. */
  | { readonly type: 'edit'; readonly id: string; readonly rect: RectDto }
  | { readonly type: 'remove'; readonly id: string }
  /** The source link was clicked: show the commented text. */
  | { readonly type: 'reveal'; readonly id: string }
  | { readonly type: 'clear' }
  /**
   * Text selected in the conversation is to be commented on: its Comment button was clicked,
   * or (with the `id` of a `commentSelection` control) the shell asked; null: none selected.
   */
  | { readonly type: 'selection'; readonly selection: ConversationSelectionDto | null; readonly id?: number };

export interface KeyEventDto {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
}

/** Posted by the bootstrap script in a webview to the shell. `ccw` holds the webview id. */
export type WebviewToShellMessage =
  | { readonly ccw: string; readonly kind: 'message'; readonly message: unknown }
  | { readonly ccw: string; readonly kind: 'state'; readonly state: unknown }
  | { readonly ccw: string; readonly kind: 'link'; readonly href: string }
  | { readonly ccw: string; readonly kind: 'keydown'; readonly event: KeyEventDto }
  | { readonly ccw: string; readonly kind: 'focus' }
  | { readonly ccw: string; readonly kind: 'blur' }
  /** Answer to a `find` control: `active` is 1-based, 0 when there are no matches. */
  | { readonly ccw: string; readonly kind: 'findResult'; readonly matches: number; readonly active: number }
  | { readonly ccw: string; readonly kind: 'comments'; readonly event: CommentsHostEvent }
  /** The delete button of a session list's row (see `hints.sessionRows`); `title` as the row shows it. */
  | { readonly ccw: string; readonly kind: 'deleteSession'; readonly sessionId: string; readonly title: string }
  /** The mouse's back or forward button was released over the page. */
  | { readonly ccw: string; readonly kind: 'navigate'; readonly direction: 'back' | 'forward' }
  /** The usage block's link to the window's provider's prices. */
  | { readonly ccw: string; readonly kind: 'editPrices' }
  /** The link to the conversation's full transcript (pages with `hints.omittedRows`). */
  | { readonly ccw: string; readonly kind: 'fullTranscript' }
  /** The session list's "this API only" toggle. */
  | { readonly ccw: string; readonly kind: 'toggleProviderFilter' }
  /** The provider notice's button: switch the window to `providerId` and open the session again. */
  | { readonly ccw: string; readonly kind: 'switchProvider'; readonly providerId: string; readonly sessionId: string }
  /**
   * A file link's message held back (pages with `hints.fileLinks`): Shift+clicked (`system`), or
   * right-clicked (`menu`; `link` is the href of a Markdown link). The shell answers with a
   * `fileLink` control.
   */
  | {
      readonly ccw: string;
      readonly kind: 'fileLink';
      readonly id: number;
      readonly path: string;
      readonly intent: 'system' | 'menu';
      readonly link?: string;
    }
  /**
   * Files are dragged over the page (`over`, at x, y in the page), left it (`leave`), were
   * dropped on it (`drop`, which the page takes itself), or the drag ended otherwise (`end`: the
   * mouse moves again): the shell shows where files can go meanwhile.
   */
  | {
      readonly ccw: string;
      readonly kind: 'fileDrag';
      readonly phase: 'over' | 'leave' | 'drop' | 'end';
      readonly x: number;
      readonly y: number;
    };

export type FindDirection = 'restart' | 'next' | 'previous';

/**
 * Control messages the shell posts into a webview. Extension messages are posted as-is
 * (exactly what the extension passed to `webview.postMessage`), so these carry a marker.
 */
export type ShellToWebviewControl =
  | { readonly ccwControl: 'theme'; readonly theme: ThemeData }
  | {
      readonly ccwControl: 'find';
      readonly text: string;
      readonly matchCase: boolean;
      readonly direction: FindDirection;
    }
  | { readonly ccwControl: 'findStop' }
  /** The comment blocks to show above the input (pages with `commentsAnchor` only); null: none. */
  | { readonly ccwControl: 'comments'; readonly view: CommentsViewDto | null }
  /** Translate the extension's UI text with this table from now on; null: show it as it was. */
  | { readonly ccwControl: 'translations'; readonly translations: ExtensionTranslations | null }
  /** When each usage bar resets (epoch ms), by the bar's label as the extension writes it (from the bridge). */
  | { readonly ccwControl: 'usageResets'; readonly resets: Readonly<Record<string, number>> }
  /** How many sessions wait for the user (from the bridge). */
  | { readonly ccwControl: 'needsInput'; readonly count: number }
  /** Plays the page its own use of Escape that the shell took over (pages with `hints.conversationEscapes`). */
  | { readonly ccwControl: 'escape'; readonly action: 'interrupt' | 'rewind' }
  /** The session list's usage block (pages with `hints.usageBlock`); null: none, the extension's own shows. */
  | { readonly ccwControl: 'usageView'; readonly view: UsageViewDto | null }
  /** The sessions' providers (session lists: pages with `hints.sessionRows`). */
  | { readonly ccwControl: 'sessionProviders'; readonly view: SessionProvidersDto | null }
  /** The sessions a session list hides: not active for longer than the setting shows (pages with `hints.sessionRows`). */
  | { readonly ccwControl: 'oldSessions'; readonly ids: readonly string[] }
  /** The bar above the message input (pages with `commentsAnchor`); null: none. */
  | { readonly ccwControl: 'providerNotice'; readonly notice: ProviderNoticeDto | null }
  /** What to do with a file link's held message: pass it on to the extension (`release`), or drop it. */
  | { readonly ccwControl: 'fileLink'; readonly id: number; readonly release: boolean }
  /** Show the markers by a conversation's scrollbar or not (pages with `hints.messageMarkers`). */
  | { readonly ccwControl: 'messageMarkers'; readonly enabled: boolean }
  /** Scroll a conversation to the user's message before or after the one in view (pages with `hints.messageMarkers`). */
  | { readonly ccwControl: 'jumpToMessage'; readonly direction: 'previous' | 'next' }
  /** Report the text selected in the conversation (a `selection` comments event with this id; pages with `hints.conversationComments`). */
  | { readonly ccwControl: 'commentSelection'; readonly id: number }
  /** Scroll to commented text of the conversation and flash it (pages with `hints.conversationComments`). */
  | { readonly ccwControl: 'revealQuote'; readonly quote: ConversationQuoteDto }
  /** Send `text` as the user does (pages with `hints.promptSubmit`); answered with a `PromptSubmitReply`. */
  | { readonly ccwControl: 'submitPrompt'; readonly id: number; readonly text: string };
