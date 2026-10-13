/**
 * The API calls in Claude Code's transcripts, for what conversations cost under a provider
 * (platform/usage.ts). Lives in the sessions worker (sessionSearchWorker.ts), next to the
 * search index but apart from it: it keeps only the calls, not what was said.
 *
 * A call is a `type: "assistant"` line (checked against Claude Code 2.1.29x):
 * `message.{id, model, usage.{input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens}}` and `timestamp`. The CLI writes one line per content block
 * of a reply, each with the reply's usage, so calls are told apart by `message.id`. A
 * subagent's calls are in `<session id>/subagents/*.jsonl`. Calls the CLI makes for itself
 * (titles...) are not in the transcripts; they are a small share and not counted.
 *
 * Transcripts only grow: a file that got longer is read from where the last read stopped.
 * Each call read is put in the ledger too (usageLedger.ts), which keeps it once its transcript
 * is gone: an API's total, deleted conversations included.
 */

import { open, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { ProviderPricing } from '../../platform/pricing';
import type { AttributedProvider, ModelTokens, SessionTag, SessionUsage, UsageCall, UsageScopes } from '../../platform/usage';
import { lastProvider, modelsUsed, sessionUsageByProvider, summarizeUsage } from '../../platform/usage';
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

/**
 * Adds the calls of complete transcript lines to `calls` (by message id: a later line of the
 * same reply replaces the earlier). Returns the folder the lines say the session ran in.
 */
export function parseUsageLines(text: string, calls: Map<string, UsageCall>): string | undefined {
  let cwd: string | undefined;
  for (const line of text.split('\n')) {
    // Most lines are something else: skip them before parsing.
    if (!line.includes('"usage"')) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== 'assistant' || !isRecord(entry.message)) {
      continue;
    }
    const { id, model, usage, content } = entry.message;
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    if (
      typeof id !== 'string' ||
      typeof model !== 'string' ||
      !model ||
      model === SYNTHETIC_MODEL ||
      !isRecord(usage) ||
      Number.isNaN(at)
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
      cwd ??= entry.cwd;
    }
  }
  return cwd;
}

interface FileState {
  readonly mtimeMs: number;
  readonly size: number;
  /** Where the last complete line read ends. */
  readonly offset: number;
  readonly calls: Map<string, UsageCall>;
  readonly cwd: string | undefined;
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
  const calls = from?.calls ?? new Map<string, UsageCall>();
  const cwd = parseUsageLines(buffer.toString('utf8', 0, end), calls);
  return { mtimeMs: stats.mtimeMs, size: stats.size, offset: offset + end, calls, cwd: from?.cwd ?? cwd };
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

  /** Every session's calls, its subagents' with them. */
  private sessions(): SessionUsage[] {
    return this.sessionFiles.flatMap((files) => {
      const transcript = this.files.get(files.transcript);
      if (!transcript) {
        return [];
      }
      const subagents = files.subagents.flatMap((file) => {
        const state = this.files.get(file);
        return state ? [state] : [];
      });
      const calls = [transcript, ...subagents].flatMap((state) => [...state.calls.values()]);
      const folder = transcript.cwd ?? subagents.find((state) => state.cwd !== undefined)?.cwd;
      return [{ sessionId: files.sessionId, folder, calls }];
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
