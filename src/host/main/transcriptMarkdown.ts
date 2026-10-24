/**
 * A session's whole transcript as Markdown, to read in the content pane's preview: the
 * conversation page leaves out a long conversation's earlier tool calls and thinking (it shows
 * its last 600 rows, anthropic.claude-code 2.1.302 on), the transcript on disk has them all.
 *
 * Read from Claude Code's own storage (checked against Claude Code 2.1.3xx, see
 * sessionTranscripts.ts): `<session id>.jsonl`, one entry per line, each message's content
 * blocks an entry of their own linked by `parentUuid`; subagents' in
 * `<session id>/subagents/agent-<id>.jsonl`, whose `.meta.json` names the tool call that
 * started it (`toolUseId`). Unknown kinds of entries and broken lines are skipped.
 *
 * Long tool input and output is cut (saying how long it was); thinking, tool results and
 * subagents fold away (`<details>`). Raw HTML in what was said is shown as text, so it cannot
 * break that structure.
 */

export interface TranscriptLabels {
  readonly you: string;
  readonly claude: string;
  readonly thinking: string;
  /** A tool call's input, folded. */
  readonly input: string;
  /** A tool call's output; `{0}`: its length, e.g. "12 lines". */
  readonly result: string;
  /** A tool call's output that is an error; `{0}` as above. */
  readonly error: string;
  /** No output came (the call was interrupted, or the conversation ended there). */
  readonly noResult: string;
  readonly oneLine: string;
  /** `{0}` lines (more than one, or none). */
  readonly lines: string;
  /** What was cut: `{0}` more lines. */
  readonly moreLines: string;
  readonly image: string;
  /** A subagent's own conversation, folded. */
  readonly subagent: string;
  readonly compacted: string;
  /** The summary the conversation went on from after compaction. */
  readonly summary: string;
  readonly plan: string;
}

export const ENGLISH_LABELS: TranscriptLabels = {
  you: 'You',
  claude: 'Claude',
  thinking: 'Thinking',
  input: 'Input',
  result: 'Result · {0}',
  error: 'Error · {0}',
  noResult: 'No result',
  oneLine: '1 line',
  lines: '{0} lines',
  moreLines: '{0} more lines',
  image: 'Image',
  subagent: 'Subagent',
  compacted: 'Conversation compacted',
  summary: 'Summary',
  plan: 'Plan',
};

export interface TranscriptMarkdownOptions {
  readonly title: string;
  readonly sessionId: string;
  readonly labels?: TranscriptLabels;
  /** Subagents' transcripts by the id of the tool call that started each. */
  readonly subagents?: ReadonlyMap<string, string>;
  /** A time as shown; `withDate` on the first and when the day changes. Local time by default. */
  readonly formatTime?: (time: Date, withDate: boolean) => string;
}

/** Lines of a tool's input or output shown before the rest is cut. */
export const SHOWN_LINES = 40;
/** Characters of one line shown before the rest of it is cut. */
const LINE_CHARS = 400;
/** A tool call's main argument on its line. */
const SUMMARY_CHARS = 200;
/** Subagents within subagents shown at most this deep. */
const MAX_DEPTH = 3;

type Entry = Record<string, unknown>;
type Block = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');

function format(template: string, ...args: (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => String(args[Number(index)] ?? match));
}

function parseEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry)) {
        entries.push(entry);
      }
    } catch {
      // A broken line (one being written, say) is one line less.
    }
  }
  return entries;
}

const isMessage = (entry: Entry): boolean => entry.type === 'user' || entry.type === 'assistant';

/**
 * The conversation as it stands: from the latest message back to the first through each
 * entry's parent (a rewind leaves the abandoned branch in the file), and across compaction
 * (its boundary's `logicalParentUuid`). Falls back to the file's order when the links do not
 * hold (most of the messages not reached).
 */
function mainChain(entries: readonly Entry[]): Entry[] {
  const byUuid = new Map<string, Entry>();
  let leaf: Entry | undefined;
  let messages = 0;
  for (const entry of entries) {
    if (typeof entry.uuid === 'string') {
      byUuid.set(entry.uuid, entry);
    }
    if (isMessage(entry) && entry.isSidechain !== true) {
      leaf = entry;
      messages++;
    }
  }
  const chain: Entry[] = [];
  const seen = new Set<Entry>();
  for (let entry = leaf; entry && !seen.has(entry);) {
    seen.add(entry);
    chain.push(entry);
    const parent = entry.parentUuid ?? entry.logicalParentUuid;
    entry = typeof parent === 'string' ? byUuid.get(parent) : undefined;
  }
  chain.reverse();
  if (chain.filter(isMessage).length * 2 < messages) {
    return entries.filter((entry) => entry.isSidechain !== true);
  }
  return chain;
}

function contentBlocks(entry: Entry): Block[] {
  const content = isRecord(entry.message) ? entry.message.content : undefined;
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** The longest run of `char` in `text`. */
function longestRun(text: string, char: string): number {
  let longest = 0;
  let run = 0;
  for (const c of text) {
    run = c === char ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** `text` as a fenced code block that nothing in it can close. */
export function codeBlock(text: string, language = ''): string {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

/** `text` cut to `length` (not through a character of two code units) with an ellipsis. */
function shorten(text: string, length: number): string {
  if (text.length <= length) {
    return text;
  }
  const code = text.charCodeAt(length - 1);
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length)}…`;
}

/** `text` on one line as inline code. */
export function inlineCode(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const shown = shorten(oneLine, SUMMARY_CHARS);
  const ticks = '`'.repeat(longestRun(shown, '`') + 1);
  const pad = shown.startsWith('`') || shown.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${shown}${pad}${ticks}`;
}

/**
 * Markdown with its raw HTML shown as text (`<` outside code made `&lt;`): what was said is
 * rendered as Markdown, as the conversation page does, but a tag in it must not open or close
 * the transcript's own folds.
 */
export function escapeHtml(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = undefined;
      }
      out.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      continue;
    }
    // Outside code spans: a span is a run of backticks closed by a run as long.
    let result = '';
    let at = 0;
    while (at < line.length) {
      const tick = line.indexOf('`', at);
      if (tick < 0) {
        result += line.slice(at).replace(/</g, '&lt;');
        break;
      }
      result += line.slice(at, tick).replace(/</g, '&lt;');
      let length = 1;
      while (line[tick + length] === '`') {
        length++;
      }
      const ticks = '`'.repeat(length);
      let close = line.indexOf(ticks, tick + length);
      while (close >= 0 && line[close + length] === '`') {
        close = line.indexOf(ticks, close + length + 1);
      }
      if (close < 0) {
        result += ticks;
        at = tick + length;
        continue;
      }
      result += line.slice(tick, close + length);
      at = close + length;
    }
    out.push(result);
  }
  return out.join('\n');
}

/** At most `SHOWN_LINES` lines of `text`, each cut to `LINE_CHARS`, and how many lines there were. */
function cut(text: string): { shown: string; total: number; more: number } {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const shown = lines.slice(0, SHOWN_LINES).map((line) => shorten(line, LINE_CHARS));
  return { shown: shown.join('\n'), total: lines.length, more: Math.max(0, lines.length - SHOWN_LINES) };
}

function details(summary: string, body: string, open = false): string {
  return `<details${open ? ' open' : ''}>\n<summary>${summary.replace(/</g, '&lt;')}</summary>\n\n${body}\n\n</details>`;
}

/** The text of a tool result's content: a string, or text and image blocks. */
function resultText(content: unknown, labels: TranscriptLabels): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(isRecord)
    .map((block) =>
      block.type === 'text' && typeof block.text === 'string' ? block.text : block.type === 'image' ? `[${labels.image}]` : '',
    )
    .filter(Boolean)
    .join('\n');
}

/** The argument a tool call is known by, shown on its line. */
const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt'];

/** The input's argument shown on the call's line: its key and value. */
function summaryOf(input: Record<string, unknown>): [string, string] | undefined {
  const keys = [...SUMMARY_KEYS, ...Object.keys(input)];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return [key, value];
    }
  }
  return undefined;
}

/** Old and new text as a diff: every old line removed, every new line added. */
function diff(oldText: string, newText: string): string {
  const removed = oldText ? oldText.split('\n').map((line) => `-${line}`) : [];
  const added = newText ? newText.split('\n').map((line) => `+${line}`) : [];
  return [...removed, ...added].join('\n');
}

interface ToolResult {
  readonly content: unknown;
  readonly isError: boolean;
}

/** Writes one conversation's entries (the session's, or a subagent's) as Markdown. */
class Writer {
  private readonly out: string[] = [];
  private lastDay: string | undefined;
  /** Claude has said something since the user last did (one heading per reply). */
  private replying = false;

  constructor(
    private readonly results: ReadonlyMap<string, ToolResult>,
    private readonly options: TranscriptMarkdownOptions,
    private readonly labels: TranscriptLabels,
    private readonly depth: number,
  ) {}

  get markdown(): string {
    return this.out.join('\n\n');
  }

  write(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        this.out.push('---', `*${this.labels.compacted}${this.stamp(entry)}*`);
        this.replying = false;
      } else if (entry.type === 'user') {
        this.user(entry);
      } else if (entry.type === 'assistant') {
        this.assistant(entry);
      }
    }
  }

  private stamp(entry: Entry): string {
    const time = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : undefined;
    if (!time || Number.isNaN(time.getTime())) {
      return '';
    }
    const day = time.toDateString();
    const withDate = day !== this.lastDay;
    this.lastDay = day;
    return ` · ${(this.options.formatTime ?? localTime)(time, withDate)}`;
  }

  private heading(label: string, entry: Entry): void {
    // Inside a subagent's fold, headings would break the document's outline.
    this.out.push(
      this.depth === 0 ? `${label === this.labels.you ? '##' : '###'} ${label}${this.stamp(entry)}` : `**${label}**${this.stamp(entry)}`,
    );
  }

  private user(entry: Entry): void {
    const blocks = contentBlocks(entry);
    if (entry.isCompactSummary === true) {
      const text = blocks.map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n\n');
      this.out.push(details(this.labels.summary, escapeHtml(text)));
      this.replying = false;
      return;
    }
    // Tool results go with their calls; reminders and other context the CLI adds are left out.
    if (entry.toolUseResult !== undefined || entry.isMeta === true || entry.isVisibleInTranscriptOnly === true) {
      return;
    }
    if (blocks.length > 0 && blocks.every((block) => block.type === 'tool_result')) {
      return;
    }
    const parts: string[] = [];
    for (const block of blocks) {
      if (block.type === 'image') {
        parts.push(`*[${this.labels.image}]*`);
      } else if (block.type === 'text' && typeof block.text === 'string') {
        const said = userText(block.text);
        if (said) {
          parts.push(said);
        }
      }
    }
    if (parts.length === 0 || this.depth > 0) {
      // A subagent's prompt is shown with the call that started it.
      return;
    }
    this.heading(this.labels.you, entry);
    this.out.push(...parts);
    this.replying = false;
  }

  private assistant(entry: Entry): void {
    for (const block of contentBlocks(entry)) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        this.reply(entry);
        this.out.push(escapeHtml(block.text.trim()));
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        this.reply(entry);
        this.out.push(details(this.labels.thinking, escapeHtml(block.thinking.trim())));
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        this.reply(entry);
        this.toolUse(block.name, typeof block.id === 'string' ? block.id : '', isRecord(block.input) ? block.input : {});
      }
    }
  }

  private reply(entry: Entry): void {
    if (!this.replying) {
      this.replying = true;
      if (this.depth === 0) {
        this.heading(this.labels.claude, entry);
      }
    }
  }

  private toolUse(name: string, id: string, input: Record<string, unknown>): void {
    const summary = summaryOf(input);
    this.out.push(`**${name}**${summary ? ` ${inlineCode(summary[1])}` : ''}`);
    const shown = this.input(name, input, summary?.[0]);
    if (shown) {
      this.out.push(shown);
    }
    const subagent = this.options.subagents?.get(id);
    if (subagent !== undefined && this.depth < MAX_DEPTH) {
      // A subagent's transcript does not branch: its entries in the file's order.
      const entries = parseEntries(subagent);
      const writer = new Writer(resultsOf(entries), this.options, this.labels, this.depth + 1);
      writer.write(entries);
      if (writer.markdown) {
        this.out.push(details(this.labels.subagent, writer.markdown));
      }
    }
    this.out.push(this.result(this.results.get(id)));
  }

  /** What a call's input is shown as, besides the argument on its line. */
  private input(name: string, input: Record<string, unknown>, summaryKey: string | undefined): string | undefined {
    const { labels } = this;
    if (name === 'ExitPlanMode' && typeof input.plan === 'string') {
      return details(labels.plan, escapeHtml(input.plan), true);
    }
    if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      return details(labels.input, this.cutBlock(diff(input.old_string, input.new_string), 'diff'));
    }
    if (name === 'MultiEdit' && Array.isArray(input.edits)) {
      const edits = input.edits.filter(isRecord).map((edit) => diff(stringOf(edit.old_string), stringOf(edit.new_string)));
      return details(labels.input, this.cutBlock(edits.join('\n'), 'diff'));
    }
    if (name === 'Write' && typeof input.content === 'string') {
      return details(labels.input, this.cutBlock(input.content));
    }
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      return input.todos
        .filter(isRecord)
        .map((todo) => `- [${todo.status === 'completed' ? 'x' : ' '}] ${escapeHtml(stringOf(todo.content)).replace(/\n/g, ' ')}`)
        .join('\n');
    }
    const rest = Object.entries(input).filter(([key]) => key !== summaryKey);
    if (rest.length === 0) {
      return undefined;
    }
    return details(labels.input, this.cutBlock(JSON.stringify(Object.fromEntries(rest), null, 2), 'json'));
  }

  private result(result: ToolResult | undefined): string {
    if (!result) {
      return `*${this.labels.noResult}*`;
    }
    const text = resultText(result.content, this.labels);
    const { total } = cut(text);
    const lines = text ? total : 0;
    const label = format(
      result.isError ? this.labels.error : this.labels.result,
      lines === 1 ? this.labels.oneLine : format(this.labels.lines, lines),
    );
    return details(label, text ? this.cutBlock(text) : '');
  }

  private cutBlock(text: string, language = ''): string {
    const { shown, more } = cut(text);
    return more > 0 ? `${codeBlock(shown, language)}\n\n*${format(this.labels.moreLines, more)}*` : codeBlock(shown, language);
  }
}

/**
 * What the user typed, as shown: context the CLI and the IDE add (the open file, reminders...)
 * left out, a slash command by its name and arguments.
 */
function userText(text: string): string | undefined {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
    return inlineCode(args ? `${command} ${args}` : command);
  }
  if (CONTEXT_BLOCK.test(text)) {
    return undefined;
  }
  const said = text.trim();
  return said ? escapeHtml(said) : undefined;
}

/** Context in a user message, not typed (as in sessionTranscripts.ts). */
const CONTEXT_BLOCK =
  /^\s*<(ide_[a-z_]+|system-reminder|command-[a-z-]+|local-command-[a-z-]+|task-notification|bash-[a-z-]+|user-prompt-submit-hook)\b/;

/** Every tool result in `entries`, by the id of its call. */
function resultsOf(entries: readonly Entry[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const entry of entries) {
    if (entry.type !== 'user') {
      continue;
    }
    for (const block of contentBlocks(entry)) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        results.set(block.tool_use_id, { content: block.content, isError: block.is_error === true });
      }
    }
  }
  return results;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localTime(time: Date, withDate: boolean): string {
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  return withDate ? `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${clock}` : clock;
}

/** The transcript `text` (a session's `.jsonl`) as a Markdown document. */
export function transcriptMarkdown(text: string, options: TranscriptMarkdownOptions): string {
  const labels = options.labels ?? ENGLISH_LABELS;
  const entries = parseEntries(text);
  const writer = new Writer(resultsOf(entries), options, labels, 0);
  writer.write(mainChain(entries));
  const cwd = entries.find((entry) => typeof entry.cwd === 'string')?.cwd as string | undefined;
  const header = [inlineCode(options.sessionId), ...(cwd ? [inlineCode(cwd)] : [])].join(' · ');
  return `# ${escapeHtml(options.title.replace(/\s+/g, ' ').trim())}\n\n${header}\n\n${writer.markdown}\n`;
}
