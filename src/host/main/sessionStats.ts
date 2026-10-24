/**
 * The statistics page's numbers (features/stats) from Claude Code's session transcripts: how many
 * messages the user typed, how long Claude's replies and thinking ran, the tools called, the files
 * changed, and the API calls and tokens: the same transcripts `sessionUsage.ts` prices, read here
 * for their shape instead. Lives in the sessions worker (sessionSearchWorker.ts), next to the search
 * and usage indexes but apart from them: it keeps only the counts, not what was said.
 *
 * The format (checked against Claude Code 2.1.282 and 2.1.291, and the fields `sessionUsage.ts`
 * knows from 2.1.29x):
 *  - One JSON object per line. The CLI writes most kinds of entries with their type first
 *    (`{"type":"api-request",...`), a tool's result as a user message with a `toolUseResult`
 *    (`{"parentUuid":...,"type":"user",...,"toolUseResult":...`), and a reply one line per
 *    content block, every line carrying the reply's `message.id` and `message.usage`.
 *  - A reply's line: `{"parentUuid":...,"isSidechain":false,"message":{"id":...,
 *    "role":"assistant","model":...,"content":[{...one block...}]},"usage":{...},
 *    "type":"assistant","timestamp":"...","cwd":"..."}`. The block is `{"type":"thinking",...}`,
 *    `{"type":"redacted_thinking",...}`, `{"type":"text","text":...}` or
 *    `{"type":"tool_use","id":...,"name":...,"input":...}`.
 *  - An edit's result: `"toolUseResult":{"filePath":...,"oldString":...,"newString":...,
 *    "structuredPatch":[{"oldStart":...,"oldLines":...,"newStart":...,"newLines":...,
 *    "lines":[" ...","-...","+...",...]}]}`. Each line of a hunk starts with ` ` (context),
 *    `-` (removed) or `+` (added). Edit and MultiEdit have no `type`; Write's result is
 *    `"type":"update"` with a patch, or `"type":"create"` for a new file (an empty patch, the
 *    whole `content` is new).
 *  - Claude Code's own dollar count: `{"type":"cost-state","sessionId":...,"totalCostUSD":...,
 *    "startTime":...}`, written as a process exits and again as it goes on, all with the same
 *    `startTime`.
 *
 * Transcripts only grow: a file that got longer is read from where the last read stopped, and
 * each file keeps an accumulator (the counts, not the text), so a reply split across reads adds
 * up right. A question sooner than RESCAN_MS after the last scan uses what is read.
 */

import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { NIGHT_ENDS_HOUR, type ActivityGrid, type CountedName, type TranscriptStats } from '../../platform/stats';
import { modelKey } from '../../platform/pricing';
import type { TokenCounts, UsageCall } from '../../platform/usage';
import { readAppended, type AppendedState } from '../node/appendedFile';
import { normalizeForCompare } from '../node/paths';

/** A question sooner than this after the last look at the files uses what is read. */
const RESCAN_MS = 1000;
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** Replies the CLI makes up itself (errors, interruptions), with no tokens. */
const SYNTHETIC_MODEL = '<synthetic>';

/** The activity grid: 7 weekdays (Monday row 0) x 24 hours. */
const GRID_HOURS = 24;
const DAY_MS = 86_400_000;

/** What the statistics index answers (in the sessions worker). */
export type StatsRequest =
  /** Every session's stats, or only those whose `cwd` is `folder` (compared case-insensitively). */
  | { readonly kind: 'transcripts'; readonly folder?: string }
  /** Claude Code's own dollar figure per session (only `folder`'s, when given); those without one are left out. */
  | { readonly kind: 'cliCosts'; readonly folder?: string };

export interface StatsResults {
  transcripts: TranscriptStats;
  cliCosts: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

const tokens = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Text blocks of a user message that are context, not typed: the IDE's open file and selection,
 * slash command records and output, reminders, task notifications (the same as sessionTranscripts).
 */
const CONTEXT_BLOCK =
  /^\s*<(ide_[a-z_]+|system-reminder|command-[a-z-]+|local-command-[a-z-]+|task-notification|bash-[a-z-]+|user-prompt-submit-hook)\b/;

/** Keys for telling a line's kind without parsing it (a JSON string holds no bare quote). */
const TYPE_KEY = '"type":"';
const TYPE_FIRST = `{${TYPE_KEY}`;
const USED_TYPES = new Set(['custom-title', 'ai-title', 'user', 'assistant', 'cost-state']);
const MESSAGE_FIRST = '{"parentUuid":';
const USER_TYPE = `${TYPE_KEY}user"`;
const TOOL_RESULT_KEY = '"toolUseResult":';
const PATCH_KEY = '"structuredPatch"';
const CREATE_KEY = '"type":"create"';

/**
 * A line of an entry the stats have no use for, told without parsing it: most of a transcript's
 * bytes, which the first read of them all would parse for nothing.
 *  - The CLI writes most kinds of entries with their type first (`{"type":"api-request",...`).
 *  - A tool's result is a user message with a `toolUseResult`; it is worth parsing only for what
 *    an edit added and removed (its `structuredPatch`) or a Write made a new file (`"type":"create"`).
 *    Read/Grep/Bash results — the biggest lines — have neither, so they are skipped without parsing.
 * Messages written some other way are parsed.
 */
function skipLine(line: string): boolean {
  if (line.startsWith(TYPE_FIRST)) {
    return !USED_TYPES.has(line.slice(TYPE_FIRST.length, line.indexOf('"', TYPE_FIRST.length)));
  }
  if (!line.startsWith(MESSAGE_FIRST)) {
    return false;
  }
  const type = line.indexOf(TYPE_KEY);
  return (
    line.startsWith(USER_TYPE, type) &&
    line.includes(TOOL_RESULT_KEY, type) &&
    !line.includes(PATCH_KEY, type) &&
    !line.includes(CREATE_KEY, type)
  );
}

/** What a transcript's lines tell, added to as more of them are read. */
export interface StatsLines {
  /** The folder the lines say the session ran in (the first that says). */
  cwd?: string;
  /** The user's name for the session (the last given). */
  customTitle?: string;
  /** The name Claude Code generated (the latest). */
  aiTitle?: string;
  /** Messages the user typed, and their characters (code points). */
  userMessages: number;
  typedChars: number;
  /** The first and last message typed (epoch ms). */
  first?: number;
  last?: number;
  /** The message typed latest in the night (`latestOffset`), with its time. */
  latest?: number;
  latestOffset?: number;
  /** Messages typed, by local day (`YYYY-MM-DD`) and by weekday (Mon 0) x hour. */
  readonly days: Map<string, number>;
  readonly activity: number[];
  /** Claude's replies with text (by message id; subagents' left out). */
  replies: number;
  replyChars: number;
  readonly repliesSeen: Set<string>;
  /** Thinking blocks (`redacted_thinking` too), and tool calls by name. */
  thinking: number;
  toolCalls: number;
  readonly tools: Map<string, number>;
  /** Subagents started (Task / Agent tool calls). */
  subagents: number;
  /** Lines edits added and removed, and the distinct files changed. */
  linesAdded: number;
  linesRemoved: number;
  readonly filesEdited: Set<string>;
  /** The API calls, by message id (subagents' included). */
  readonly calls: Map<string, UsageCall>;
  /** Claude Code's own dollar count, per process (`cost-state` `startTime`; the last line wins). */
  readonly costs: Map<number, number>;
}

export const newStatsLines = (): StatsLines => ({
  userMessages: 0,
  typedChars: 0,
  days: new Map(),
  activity: Array.from({ length: GRID_HOURS * 7 }, () => 0),
  replies: 0,
  replyChars: 0,
  repliesSeen: new Set(),
  thinking: 0,
  toolCalls: 0,
  tools: new Map(),
  subagents: 0,
  linesAdded: 0,
  linesRemoved: 0,
  filesEdited: new Set(),
  calls: new Map(),
  costs: new Map(),
});

/** Characters as people count them, near enough: code points (an emoji is one, not two). */
function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

/** A parsed line's own time (not one in its content: a tool result may have such). */
function entryTime(entry: unknown): number | undefined {
  const time = isRecord(entry) && typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isNaN(time) ? undefined : time;
}

/**
 * Where a time falls in its "night": a day is taken to start at NIGHT_ENDS_HOUR (05:00 local),
 * so 03:47 is later than 23:10. The difference from the day's 05:00 is in absolute milliseconds,
 * which stays monotonic across a daylight-saving change.
 */
function nightOffset(at: number): number {
  const d = new Date(at);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), NIGHT_ENDS_HOUR, 0, 0, 0).getTime();
  return (at - dayStart + DAY_MS) % DAY_MS;
}

/** The local day as `YYYY-MM-DD`. */
function dateKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The local date as a day ordinal (its `Date.UTC`), so consecutive days are exactly DAY_MS apart. */
function dayOrdinal(key: string): number {
  const [y, m, d] = key.split('-');
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
}

function keyFromOrdinal(ordinal: number): string {
  const d = new Date(ordinal);
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${month}-${day}`;
}

/**
 * The days with a message, the longest run of them in a row, and the run up to `now` (ending
 * today, or yesterday when today has nothing yet). Days are the local dates `YYYY-MM-DD`, sorted.
 */
export function streaks(days: readonly string[], now: number): { activeDays: number; longestStreak: number; currentStreak: number } {
  const active = new Set(days);
  let longestStreak = 0;
  let run = 0;
  let previous: number | undefined;
  for (const key of days) {
    const ordinal = dayOrdinal(key);
    run = previous !== undefined && ordinal - previous === DAY_MS ? run + 1 : 1;
    if (run > longestStreak) {
      longestStreak = run;
    }
    previous = ordinal;
  }
  const today = dayOrdinal(dateKey(new Date(now)));
  let end = active.has(keyFromOrdinal(today)) ? today : today - DAY_MS;
  let currentStreak = 0;
  while (active.has(keyFromOrdinal(end))) {
    currentStreak += 1;
    end -= DAY_MS;
  }
  return { activeDays: days.length, longestStreak, currentStreak };
}

/** Adds what complete transcript lines tell to `lines`. `subagent` counts only thinking, tools and tokens. */
export function parseStatsLines(text: string, lines: StatsLines, subagent = false): void {
  for (const line of text.split('\n')) {
    if (!line.trim() || skipLine(line)) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    addEntry(entry, lines, subagent);
  }
}

function addEntry(entry: Record<string, unknown>, lines: StatsLines, subagent: boolean): void {
  if (subagent) {
    // A subagent's file counts only its thinking, tools and tokens, not messages or edits.
    if (entry.type === 'assistant') {
      addAssistant(entry, lines, true);
    }
    return;
  }
  if (!lines.cwd) {
    lines.cwd = nonEmptyString(entry.cwd);
  }
  switch (entry.type) {
    case 'custom-title':
      lines.customTitle = nonEmptyString(entry.customTitle) ?? lines.customTitle;
      return;
    case 'ai-title':
      lines.aiTitle = nonEmptyString(entry.aiTitle) ?? lines.aiTitle;
      return;
    case 'cost-state':
      addCost(entry, lines);
      return;
    case 'user':
      addUserMessage(entry, lines);
      return;
    case 'assistant':
      addAssistant(entry, lines, false);
      return;
    default:
      return;
  }
}

/** A `cost-state` line's own dollar figure, per process (`startTime`), the last line of a run winning. */
function addCost(entry: Record<string, unknown>, lines: StatsLines): void {
  if (typeof entry.totalCostUSD !== 'number' || !Number.isFinite(entry.totalCostUSD)) {
    return;
  }
  const start = typeof entry.startTime === 'number' && Number.isFinite(entry.startTime) ? entry.startTime : 0;
  lines.costs.set(start, entry.totalCostUSD);
}

function addUserMessage(entry: Record<string, unknown>, lines: StatsLines): void {
  // A tool's result counts only for what an edit added and removed.
  if (entry.toolUseResult !== undefined) {
    addToolResult(entry.toolUseResult, lines);
    return;
  }
  // Messages the CLI adds for itself (meta, compaction summaries) are not what the user typed.
  if (entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) {
    return;
  }
  const content = isRecord(entry.message) ? entry.message.content : undefined;
  const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  let text = '';
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      continue;
    }
    if (CONTEXT_BLOCK.test(block.text)) {
      continue; // the context the IDE and the CLI add
    }
    text += block.text;
  }
  const typed = text.trim();
  if (!typed) {
    return; // only tool results or context
  }
  lines.userMessages += 1;
  lines.typedChars += codePoints(typed);
  const at = entryTime(entry);
  if (at !== undefined) {
    noteTime(lines, at);
  }
}

function addAssistant(entry: Record<string, unknown>, lines: StatsLines, subagent: boolean): void {
  const message = isRecord(entry.message) ? entry.message : undefined;
  if (!message) {
    return;
  }
  const id = typeof message.id === 'string' ? message.id : undefined;
  const model = typeof message.model === 'string' && message.model ? message.model : undefined;
  const usage = isRecord(message.usage) ? message.usage : undefined;
  const content = Array.isArray(message.content) ? message.content : [];

  // The tokens of the reply (by message id: each of its lines carries the same usage).
  if (id !== undefined && model !== undefined && model !== SYNTHETIC_MODEL && usage !== undefined) {
    const at = entryTime(entry);
    if (at !== undefined && !lines.calls.has(id)) {
      lines.calls.set(id, {
        id,
        at,
        model,
        input: tokens(usage.input_tokens),
        output: tokens(usage.output_tokens),
        cacheRead: tokens(usage.cache_read_input_tokens),
        cacheWrite: tokens(usage.cache_creation_input_tokens),
      });
    }
  }

  let hasText = false;
  let replyChars = 0;
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      const chars = codePoints(block.text);
      if (chars > 0) {
        hasText = true;
        replyChars += chars;
      }
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      lines.thinking += 1;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      lines.toolCalls += 1;
      lines.tools.set(block.name, (lines.tools.get(block.name) ?? 0) + 1);
      if (block.name === 'Task' || block.name === 'Agent') {
        lines.subagents += 1;
      }
    }
  }
  // A reply with text is one (subagents' left out); its lines all share the id.
  if (!subagent && hasText && (id === undefined || !lines.repliesSeen.has(id))) {
    if (id !== undefined) {
      lines.repliesSeen.add(id);
    }
    lines.replies += 1;
    lines.replyChars += replyChars;
  }
}

/** What an edit's result added and removed, and the file it changed. */
function addToolResult(result: unknown, lines: StatsLines): void {
  if (!isRecord(result)) {
    return;
  }
  const file = nonEmptyString(result.filePath);
  if (result.type === 'create' && typeof result.content === 'string') {
    // Write made a new file: no patch, the whole content is new.
    lines.linesAdded += contentLines(result.content);
    if (file !== undefined) {
      lines.filesEdited.add(normalizeForCompare(file));
    }
    return;
  }
  if (!Array.isArray(result.structuredPatch)) {
    return;
  }
  let added = 0;
  let removed = 0;
  for (const hunk of result.structuredPatch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) {
      continue;
    }
    for (const patchLine of hunk.lines) {
      if (typeof patchLine !== 'string') {
        continue;
      }
      if (patchLine.startsWith('+')) {
        added += 1;
      } else if (patchLine.startsWith('-')) {
        removed += 1;
      }
    }
  }
  if (added === 0 && removed === 0) {
    return;
  }
  lines.linesAdded += added;
  lines.linesRemoved += removed;
  if (file !== undefined) {
    lines.filesEdited.add(normalizeForCompare(file));
  }
}

/** How many lines a written file's content is: the newline at the end is not a line. */
function contentLines(text: string): number {
  if (text === '') {
    return 0;
  }
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
}

/** Notes a typed message's time against the day, the grid and the night. */
function noteTime(lines: StatsLines, at: number): void {
  if (lines.first === undefined || at < lines.first) {
    lines.first = at;
  }
  if (lines.last === undefined || at > lines.last) {
    lines.last = at;
  }
  const offset = nightOffset(at);
  if (lines.latestOffset === undefined || offset > lines.latestOffset || (offset === lines.latestOffset && at > (lines.latest ?? 0))) {
    lines.latest = at;
    lines.latestOffset = offset;
  }
  const d = new Date(at);
  lines.days.set(dateKey(d), (lines.days.get(dateKey(d)) ?? 0) + 1);
  lines.activity[((d.getDay() + 6) % 7) * GRID_HOURS + d.getHours()] += 1;
}

/** Adds one file's counts into another (a session's subagents into it, or it into the whole). */
function addLines(into: StatsLines, from: StatsLines): void {
  into.userMessages += from.userMessages;
  into.typedChars += from.typedChars;
  into.replies += from.replies;
  into.replyChars += from.replyChars;
  into.thinking += from.thinking;
  into.toolCalls += from.toolCalls;
  into.subagents += from.subagents;
  into.linesAdded += from.linesAdded;
  into.linesRemoved += from.linesRemoved;
  for (const [name, count] of from.tools) {
    into.tools.set(name, (into.tools.get(name) ?? 0) + count);
  }
  for (const file of from.filesEdited) {
    into.filesEdited.add(file);
  }
  for (const [id, call] of from.calls) {
    if (!into.calls.has(id)) {
      into.calls.set(id, call);
    }
  }
  if (from.first !== undefined && (into.first === undefined || from.first < into.first)) {
    into.first = from.first;
  }
  if (from.last !== undefined && (into.last === undefined || from.last > into.last)) {
    into.last = from.last;
  }
  if (from.latest !== undefined && from.latestOffset !== undefined) {
    if (
      into.latestOffset === undefined ||
      from.latestOffset > into.latestOffset ||
      (from.latestOffset === into.latestOffset && from.latest > (into.latest ?? 0))
    ) {
      into.latest = from.latest;
      into.latestOffset = from.latestOffset;
    }
  }
  for (let i = 0; i < into.activity.length; i++) {
    into.activity[i] += from.activity[i];
  }
  for (const [day, count] of from.days) {
    into.days.set(day, (into.days.get(day) ?? 0) + count);
  }
}

/** Names and how many times, most first, ties by name. */
function sortCounts(counts: ReadonlyMap<string, number>): CountedName[] {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function modelCounts(calls: ReadonlyMap<string, UsageCall>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const call of calls.values()) {
    const model = modelKey(call.model);
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return counts;
}

function sumTokens(calls: ReadonlyMap<string, UsageCall>): TokenCounts {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const call of calls.values()) {
    input += call.input;
    output += call.output;
    cacheRead += call.cacheRead;
    cacheWrite += call.cacheWrite;
  }
  return { input, output, cacheRead, cacheWrite };
}

/** The flat weekday x hour counts reshaped into 7 rows of 24 (Monday row 0). */
function grid(activity: readonly number[]): ActivityGrid {
  const rows: number[][] = [];
  for (let day = 0; day < 7; day++) {
    rows.push(activity.slice(day * GRID_HOURS, (day + 1) * GRID_HOURS));
  }
  return rows;
}

function toTranscriptStats(all: StatsLines, sessions: number, folders: number, longest: TranscriptStats['longest']): TranscriptStats {
  const days = [...all.days.keys()].sort();
  const { activeDays, longestStreak, currentStreak } = streaks(days, Date.now());
  let busiestDay: TranscriptStats['busiestDay'];
  for (const date of days) {
    const count = all.days.get(date) ?? 0;
    if (busiestDay === undefined || count > busiestDay.userMessages) {
      busiestDay = { date, userMessages: count };
    }
  }
  return {
    sessions,
    folders,
    userMessages: all.userMessages,
    typedChars: all.typedChars,
    replies: all.replies,
    replyChars: all.replyChars,
    thinking: all.thinking,
    toolCalls: all.toolCalls,
    tools: sortCounts(all.tools),
    subagents: all.subagents,
    linesAdded: all.linesAdded,
    linesRemoved: all.linesRemoved,
    filesEdited: all.filesEdited.size,
    models: sortCounts(modelCounts(all.calls)),
    tokens: sumTokens(all.calls),
    longest,
    busiestDay,
    activity: grid(all.activity),
    activeDays,
    longestStreak,
    currentStreak,
    latest: all.latest,
    first: all.first,
    last: all.last,
  };
}

interface FileState extends AppendedState {
  readonly lines: StatsLines;
}

/**
 * A transcript's counts: what `known` read plus the lines added since, or all of them again
 * when the file got shorter (rewritten). A last line still being written waits for next time.
 */
export async function readStatsFile(file: string, subagent: boolean, known: FileState | undefined): Promise<FileState | undefined> {
  const read = await readAppended(file, known);
  if (read === undefined) {
    return undefined;
  }
  if (read === 'unchanged') {
    return known;
  }
  const lines = read.restarted || !known ? newStatsLines() : known.lines;
  parseStatsLines(read.text, lines, subagent);
  return { mtimeMs: read.mtimeMs, size: read.size, offset: read.offset, lines };
}

interface SessionFiles {
  readonly sessionId: string;
  readonly transcript: string;
  readonly subagents: readonly string[];
}

export class StatsIndex {
  private readonly files = new Map<string, FileState>();
  private sessionFiles: readonly SessionFiles[] = [];
  private scannedAt = 0;
  private scanning: Promise<void> | undefined;

  constructor(private readonly projectsDir: string) {}

  async answer<K extends StatsRequest['kind']>(request: Extract<StatsRequest, { kind: K }>): Promise<StatsResults[K]>;
  async answer(request: StatsRequest): Promise<StatsResults[StatsRequest['kind']]> {
    await this.refresh();
    if (request.kind === 'cliCosts') {
      return this.cliCosts(request.folder);
    }
    return this.transcripts(request.folder);
  }

  private transcripts(folder?: string): TranscriptStats {
    const wanted = folder === undefined ? undefined : normalizeForCompare(folder);
    const all = newStatsLines();
    let sessions = 0;
    const folders = new Set<string>();
    let longest: TranscriptStats['longest'];

    for (const files of this.sessionFiles) {
      const transcript = this.files.get(files.transcript);
      if (!transcript) {
        continue;
      }
      const subagents = files.subagents.flatMap((file) => {
        const state = this.files.get(file);
        return state ? [state] : [];
      });
      const cwd = transcript.lines.cwd ?? subagents.find((state) => state.lines.cwd !== undefined)?.lines.cwd;
      if (wanted !== undefined && (cwd === undefined || normalizeForCompare(cwd) !== wanted)) {
        continue;
      }
      const merged = newStatsLines();
      addLines(merged, transcript.lines);
      for (const state of subagents) {
        addLines(merged, state.lines);
      }
      if (merged.userMessages > 0) {
        sessions += 1;
        if (cwd !== undefined) {
          folders.add(normalizeForCompare(cwd));
        }
        const title = transcript.lines.customTitle ?? transcript.lines.aiTitle;
        if (longest === undefined || merged.userMessages > longest.userMessages) {
          longest = {
            sessionId: files.sessionId,
            ...(title === undefined ? {} : { title }),
            ...(cwd === undefined ? {} : { folder: cwd }),
            userMessages: merged.userMessages,
          };
        }
      }
      addLines(all, merged);
    }
    return toTranscriptStats(all, sessions, folders.size, longest);
  }

  /** Claude Code's own dollar figure per session: its `cost-state` runs added up, those without one left out. */
  private cliCosts(folder?: string): Record<string, number> {
    const wanted = folder === undefined ? undefined : normalizeForCompare(folder);
    const result: Record<string, number> = {};
    for (const files of this.sessionFiles) {
      const transcript = this.files.get(files.transcript);
      if (!transcript || transcript.lines.costs.size === 0) {
        continue;
      }
      const cwd = transcript.lines.cwd;
      if (wanted !== undefined && (cwd === undefined || normalizeForCompare(cwd) !== wanted)) {
        continue;
      }
      let total = 0;
      for (const cost of transcript.lines.costs.values()) {
        total += cost;
      }
      result[files.sessionId] = total;
    }
    return result;
  }

  private async refresh(): Promise<void> {
    if (!this.scanning && Date.now() - this.scannedAt < RESCAN_MS) {
      return;
    }
    this.scanning ??= this.scan().finally(() => {
      this.scannedAt = Date.now();
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>();
    const sessions: SessionFiles[] = [];
    const update = async (file: string, subagent: boolean): Promise<boolean> => {
      const known = this.files.get(file);
      const state = await readStatsFile(file, subagent, known);
      if (!state) {
        return false;
      }
      this.files.set(file, state);
      seen.add(file);
      return true;
    };
    const folders = await readdir(this.projectsDir, { withFileTypes: true }).catch(() => []);
    for (const folder of folders) {
      if (!folder.isDirectory()) {
        continue;
      }
      const dir = path.join(this.projectsDir, folder.name);
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const names = new Set(entries.map((entry) => entry.name));
      for (const entry of entries) {
        const sessionId = SESSION_FILE.exec(entry.name)?.[1];
        if (!sessionId || !entry.isFile()) {
          continue;
        }
        const transcript = path.join(dir, entry.name);
        if (!(await update(transcript, false))) {
          continue;
        }
        const subagents: string[] = [];
        if (names.has(sessionId)) {
          const subagentDir = path.join(dir, sessionId, 'subagents');
          for (const name of await readdir(subagentDir).catch((): string[] => [])) {
            const file = path.join(subagentDir, name);
            if (name.endsWith('.jsonl') && (await update(file, true))) {
              subagents.push(file);
            }
          }
        }
        sessions.push({ sessionId, transcript, subagents });
      }
    }
    for (const file of this.files.keys()) {
      if (!seen.has(file)) {
        this.files.delete(file);
      }
    }
    this.sessionFiles = sessions;
  }
}
