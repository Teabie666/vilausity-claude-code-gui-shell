/**
 * The API calls in Claude Code's transcripts, for what conversations cost under a provider
 * (platform/usage.ts). Lives in the sessions worker (sessionSearchWorker.ts), next to the
 * search index but apart from it: it keeps only the calls, not what was said.
 *
 * A call is a `type: "assistant"` line (checked against Claude Code 2.1.29x):
 * `message.{id, model, usage.{input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens}}` and `timestamp`. The CLI writes one line per content block
 * of a reply, each with the reply's usage, so calls are told apart by `message.id`. A
 * subagent's calls are in `<session id>/subagents/*.jsonl`.
 *
 * Calls the CLI makes for itself (a title, compacting the conversation, WebFetch's summary of a
 * page) are not in the transcripts, but its own running count is: the `cost-state` line each
 * process writes as a turn ends, `{modelUsage: {<model>: {inputTokens, outputTokens,
 * cacheReadInputTokens, cacheCreationInputTokens, ...}}}`, counting every call it made and
 * those of the processes before it on the session. What it has beyond the transcripts is
 * added as unrecorded calls (platform/usage.ts `unrecordedCalls`), at the time of the line
 * before it (its own times count only the processes' running time). Checked against what
 * DeepSeek charged (2.1.296): the transcripts alone missed a compaction, a quarter of that
 * session's cost; with these added, the cost was right.
 *
 * Transcripts only grow: a file that got longer is read from where the last read stopped.
 * Each call read is put in the ledger too (usageLedger.ts), which keeps it once its transcript
 * is gone: an API's total, deleted conversations included.
 */

import { open, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { ProviderPricing } from '../../platform/pricing';
import { modelKey } from '../../platform/pricing';
import type {
  AttributedProvider,
  ModelTokens,
  SessionTag,
  SessionUsage,
  TokenCounts,
  UsageCall,
  UsageScopes,
  UsageSnapshot,
} from '../../platform/usage';
import { lastProvider, modelsUsed, sessionUsageByProvider, summarizeUsage, unrecordedCalls } from '../../platform/usage';
import { normalizeForCompare } from '../node/paths';
import { SessionTagReader, type SessionTags } from './sessionProviders';
import { UsageLedger } from './usageLedger';

/** A question sooner than this after the last look at the files uses what is read. */
const RESCAN_MS = 1000;
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEWLINE = 0x0a;
/** Replies the CLI makes up itself (errors, interruptions), with no tokens. */
const SYNTHETIC_MODEL = '<synthetic>';

/** What the usage index answers (in the sessions worker). */
export type UsageRequest =
  | {
      readonly kind: 'summary';
      readonly providers: readonly AttributedProvider[];
      readonly provider: string;
      readonly sessionId?: string;
      readonly folder?: string;
      /** The provider's prices, for each call to be priced by its own rule. */
      readonly pricing?: ProviderPricing;
    }
  /** The models of the calls that ran under `provider`. */
  | { readonly kind: 'models'; readonly providers: readonly AttributedProvider[]; readonly provider: string }
  /** The provider a session last ran under. */
  | { readonly kind: 'lastProvider'; readonly providers: readonly AttributedProvider[]; readonly sessionId: string }
  /** The provider every session last ran under, by session id (those that can be told). */
  | { readonly kind: 'sessionProviders'; readonly providers: readonly AttributedProvider[] }
  /** One session's tokens by the provider each call ran under, priced with `pricing` (by provider id). */
  | {
      readonly kind: 'session';
      readonly providers: readonly AttributedProvider[];
      readonly sessionId: string;
      readonly pricing: Readonly<Record<string, ProviderPricing>>;
    }
  /** The tokens of every call that ran under `provider`, those of deleted sessions too (the ledger). */
  | {
      readonly kind: 'total';
      readonly providers: readonly AttributedProvider[];
      readonly provider: string;
      readonly pricing?: ProviderPricing;
    }
  /** Reads the transcripts now (not up to a second ago) and puts their calls in the ledger. */
  | { readonly kind: 'sync' };

export interface UsageResults {
  summary: UsageScopes;
  models: string[];
  lastProvider: string | undefined;
  sessionProviders: Record<string, string>;
  session: Record<string, ModelTokens>;
  total: ModelTokens;
  sync: void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const tokens = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** What a transcript's lines tell, added to as more of them are read. */
export interface UsageLines {
  /** By message id: a later line of the same reply replaces the earlier. */
  readonly calls: Map<string, UsageCall>;
  /** Claude Code's own counts (`cost-state` lines), in the order written. */
  readonly snapshots: UsageSnapshot[];
  /** The folder the lines say the session ran in (the first that says). */
  cwd?: string;
  /** The time of the last line read that has one (epoch ms). */
  lastAt?: number;
}

export const newUsageLines = (): UsageLines => ({ calls: new Map(), snapshots: [] });

/** Lines up to this long are parsed for their time: a tool's long result is not. */
const TIMED_LINE_MAX = 4096;

/** A parsed line's own time (not one in its content: a tool result may have such). */
function entryTime(entry: unknown): number | undefined {
  const time = isRecord(entry) && typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isNaN(time) ? undefined : time;
}

/** The time of a short line that has one (a turn's end, a compaction's mark...). */
function lineTime(line: string): number | undefined {
  if (line.length > TIMED_LINE_MAX || !line.includes('"timestamp"')) {
    return undefined;
  }
  try {
    return entryTime(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Times only go on: a line written out of order does not take a snapshot back. */
function later(lines: UsageLines, time: number | undefined): void {
  if (time !== undefined && (lines.lastAt === undefined || time > lines.lastAt)) {
    lines.lastAt = time;
  }
}

/** A `cost-state` line's counts by model (`modelKey`: "deepseek-flash[1m]" and "deepseek-flash" add up). */
function snapshotModels(entry: Record<string, unknown>): Record<string, TokenCounts> | undefined {
  if (!isRecord(entry.modelUsage)) {
    return undefined;
  }
  const models: Record<string, TokenCounts> = {};
  for (const [name, usage] of Object.entries(entry.modelUsage)) {
    const model = modelKey(name);
    if (!isRecord(usage) || !model) {
      continue;
    }
    const sum = models[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    models[model] = {
      input: sum.input + tokens(usage.inputTokens),
      output: sum.output + tokens(usage.outputTokens),
      cacheRead: sum.cacheRead + tokens(usage.cacheReadInputTokens),
      cacheWrite: sum.cacheWrite + tokens(usage.cacheCreationInputTokens),
    };
  }
  return models;
}

/** Adds what complete transcript lines tell to `lines`. */
export function parseUsageLines(text: string, lines: UsageLines): void {
  const calls = lines.calls;
  for (const line of text.split('\n')) {
    // Most lines are something else: skip them before parsing.
    if (!line.includes('"usage"') && !line.includes('"type":"cost-state"')) {
      later(lines, lineTime(line));
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(entry) && entry.type === 'cost-state') {
      const models = snapshotModels(entry);
      if (models && lines.lastAt !== undefined) {
        lines.snapshots.push({ at: lines.lastAt, models });
      }
      continue;
    }
    const at = entryTime(entry);
    later(lines, at);
    if (!isRecord(entry) || entry.type !== 'assistant' || !isRecord(entry.message)) {
      continue;
    }
    const { id, model, usage, content } = entry.message;
    if (
      typeof id !== 'string' ||
      typeof model !== 'string' ||
      !model ||
      model === SYNTHETIC_MODEL ||
      !isRecord(usage) ||
      at === undefined
    ) {
      continue;
    }
    // One line a content block: the reply thought when any of its lines is a thinking block.
    const thought =
      Array.isArray(content) &&
      content.some((block) => isRecord(block) && (block.type === 'thinking' || block.type === 'redacted_thinking'));
    calls.set(id, {
      id,
      at,
      model,
      ...(thought || calls.get(id)?.thinking ? { thinking: true } : {}),
      input: tokens(usage.input_tokens),
      output: tokens(usage.output_tokens),
      cacheRead: tokens(usage.cache_read_input_tokens),
      cacheWrite: tokens(usage.cache_creation_input_tokens),
    });
    if (typeof entry.cwd === 'string' && entry.cwd) {
      lines.cwd ??= entry.cwd;
    }
  }
}

interface FileState {
  readonly mtimeMs: number;
  readonly size: number;
  /** When the file was made: of two sessions with the same calls, the forked one is the later. */
  readonly createdMs: number;
  /** Where the last complete line read ends. */
  readonly offset: number;
  readonly lines: UsageLines;
}

/**
 * A transcript's calls: what `known` read plus the lines added since, or all of them again
 * when the file got shorter (rewritten). A last line still being written waits for next time.
 */
export async function readUsageFile(file: string, known: FileState | undefined): Promise<FileState | undefined> {
  const stats = await stat(file).catch(() => undefined);
  if (!stats?.isFile()) {
    return undefined;
  }
  if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) {
    return known;
  }
  const from = known && stats.size >= known.offset ? known : undefined;
  const offset = from?.offset ?? 0;
  const length = stats.size - offset;
  const buffer = Buffer.alloc(length);
  let read = 0;
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) {
    return known;
  }
  try {
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
      if (bytesRead === 0) {
        break;
      }
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  // Up to the last newline: a byte that is never part of another character in UTF-8.
  const end = buffer.subarray(0, read).lastIndexOf(NEWLINE) + 1;
  const lines = from?.lines ?? newUsageLines();
  parseUsageLines(buffer.toString('utf8', 0, end), lines);
  // A file system that keeps no creation time gives 0: the first look at it stands in.
  const createdMs = from?.createdMs ?? (stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs);
  return { mtimeMs: stats.mtimeMs, size: stats.size, createdMs, offset: offset + end, lines };
}

interface SessionFiles {
  readonly sessionId: string;
  readonly transcript: string;
  readonly subagents: readonly string[];
}

export class UsageIndex {
  private readonly files = new Map<string, FileState>();
  private sessionFiles: readonly SessionFiles[] = [];
  private scannedAt = 0;
  private scanning: Promise<void> | undefined;
  private readonly tagReader: SessionTagReader;
  private readonly ledger: UsageLedger | undefined;

  constructor(
    private readonly projectsDir: string,
    tagsFile: string,
    /** No ledger: nothing is kept of the transcripts. */
    ledgerFile?: string,
  ) {
    this.tagReader = new SessionTagReader(tagsFile);
    this.ledger = ledgerFile === undefined ? undefined : new UsageLedger(ledgerFile);
  }

  async answer<K extends UsageRequest['kind']>(request: Extract<UsageRequest, { kind: K }>): Promise<UsageResults[K]>;
  async answer(request: UsageRequest): Promise<UsageResults[UsageRequest['kind']]> {
    const [tags] = await Promise.all([this.tagReader.read(), this.refresh(request.kind === 'sync')]);
    const tagsOf = (sessionId: string): readonly SessionTag[] => tags.get(sessionId) ?? [];
    switch (request.kind) {
      case 'summary': {
        const folder = request.folder === undefined ? undefined : normalizeForCompare(request.folder);
        return summarizeUsage(this.sessions(), tagsOf, request.providers, {
          provider: request.provider,
          sessionId: request.sessionId,
          inFolder: folder === undefined ? undefined : (candidate) => normalizeForCompare(candidate) === folder,
          pricing: request.pricing,
        });
      }
      case 'models':
        return modelsUsed(this.sessions(), tagsOf, request.providers, request.provider);
      case 'lastProvider': {
        const usage = this.sessions().find((session) => session.sessionId === request.sessionId);
        return lastProvider(usage, tagsOf(request.sessionId), request.providers);
      }
      case 'sessionProviders':
        return sessionProviders(this.sessions(), tags, request.providers);
      case 'session': {
        const usage = this.sessions().find((session) => session.sessionId === request.sessionId);
        return usage ? sessionUsageByProvider(usage, tagsOf(usage.sessionId), request.providers, (id) => request.pricing[id]) : {};
      }
      case 'total': {
        // Without a ledger (it could not be read), the transcripts there are.
        const sessions = (await this.ledger?.sessions().catch(() => undefined)) ?? this.sessions();
        return summarizeUsage(sessions, tagsOf, request.providers, { provider: request.provider, pricing: request.pricing }).all;
      }
      case 'sync':
        return;
    }
  }

  /**
   * Every session's calls, its subagents' with them. A conversation forked from another starts
   * with a copy of its transcript (the same calls, by their ids): a call belongs to the session
   * whose transcript is the oldest of those it is in, the one that made it, and counts there only.
   */
  private sessions(): SessionUsage[] {
    const sessions = this.sessionFiles.flatMap((files) => {
      const transcript = this.files.get(files.transcript);
      if (!transcript) {
        return [];
      }
      const subagents = files.subagents.flatMap((file) => {
        const state = this.files.get(file);
        return state ? [state] : [];
      });
      return [{ files, transcript, calls: [transcript, ...subagents].flatMap((state) => [...state.lines.calls.values()]), subagents }];
    });
    const owner = new Map<string, string>();
    for (const { files, calls } of [...sessions].sort((a, b) => a.transcript.createdMs - b.transcript.createdMs)) {
      for (const call of calls) {
        if (call.id !== undefined && !owner.has(call.id)) {
          owner.set(call.id, files.sessionId);
        }
      }
    }
    return sessions.map(({ files, transcript, calls, subagents }) => {
      const own = calls.filter((call) => call.id === undefined || owner.get(call.id) === files.sessionId);
      const folder = transcript.lines.cwd ?? subagents.find((state) => state.lines.cwd !== undefined)?.lines.cwd;
      // The process writes its counts into the session's own transcript, its subagents' calls among them.
      const unrecorded = unrecordedCalls(files.sessionId, transcript.lines.snapshots, own);
      return { sessionId: files.sessionId, folder, calls: [...own, ...unrecorded] };
    });
  }

  /** `now`: read the files again even if they were a moment ago (a scan under way may have passed a file). */
  private async refresh(now = false): Promise<void> {
    if (now) {
      await this.scanning;
      this.scannedAt = 0;
    }
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
    /** Files read again (new or changed): their sessions' calls go into the ledger. */
    const changed = new Set<string>();
    const update = async (file: string): Promise<boolean> => {
      const known = this.files.get(file);
      const state = await readUsageFile(file, known);
      if (!state) {
        return false;
      }
      if (state !== known) {
        changed.add(file);
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
        if (!(await update(transcript))) {
          continue;
        }
        const subagents: string[] = [];
        if (names.has(sessionId)) {
          const subagentDir = path.join(dir, sessionId, 'subagents');
          for (const name of await readdir(subagentDir).catch((): string[] => [])) {
            const file = path.join(subagentDir, name);
            if (name.endsWith('.jsonl') && (await update(file))) {
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
    if (this.ledger && changed.size > 0) {
      const ids = new Set(
        sessions
          .filter((files) => [files.transcript, ...files.subagents].some((file) => changed.has(file)))
          .map((files) => files.sessionId),
      );
      // A ledger that cannot be written now is written the next time the files change.
      await this.ledger.record(this.sessions().filter((usage) => ids.has(usage.sessionId))).catch(() => undefined);
    }
  }
}

function sessionProviders(
  sessions: readonly SessionUsage[],
  tags: SessionTags,
  providers: readonly AttributedProvider[],
): Record<string, string> {
  const result: Record<string, string> = {};
  const usageOf = new Map(sessions.map((session) => [session.sessionId, session]));
  for (const sessionId of new Set([...usageOf.keys(), ...tags.keys()])) {
    const provider = SESSION_ID.test(sessionId) ? lastProvider(usageOf.get(sessionId), tags.get(sessionId) ?? [], providers) : undefined;
    if (provider !== undefined) {
      result[sessionId] = provider;
    }
  }
  return result;
}
