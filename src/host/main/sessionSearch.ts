/**
 * Searching Claude Code's sessions (`sessions.search`). The transcripts are read in a worker
 * thread (sessionSearchWorker.ts): the first read goes through every transcript (hundreds of
 * MB for a heavy user), and main must stay responsive. The index keeps what it read, keyed
 * by each file's size and modification time; a transcript that grew is read from where the
 * last read stopped (one being written can be tens of MB).
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { SessionSearchRequest, SessionSearchResult, SessionStorageDto } from '../../platform/protocol';
import type { StatsRequest, StatsResults } from './sessionStats';
import { readAppended, type AppendedState } from '../node/appendedFile';
import { normalizeForCompare } from '../node/paths';
import type { FullTranscriptRequest } from './fullTranscripts';
import { indexSession, searchSessions, TranscriptReader, type IndexedSession } from './sessionTranscripts';
import type { UsageRequest, UsageResults } from './sessionUsage';

/** A search sooner than this after the last look at the files uses what is indexed. */
const RESCAN_MS = 3000;

interface Entry extends AppendedState {
  readonly reader: TranscriptReader;
  readonly session: IndexedSession | undefined;
}

/** The index itself; lives in the worker. */
export class SessionIndex {
  private readonly entries = new Map<string, Entry>();
  private scannedAt = 0;
  private scanning: Promise<void> | undefined;

  constructor(
    private readonly projectsDir: string,
    private readonly rescanMs = RESCAN_MS,
  ) {}

  async search(request: SessionSearchRequest): Promise<SessionSearchResult[]> {
    await this.refresh();
    const folder = request.folder === undefined ? undefined : normalizeForCompare(request.folder);
    const sessions = [...this.entries.values()].flatMap((entry) =>
      entry.session && (folder === undefined || normalizeForCompare(entry.session.folder) === folder) ? [entry.session] : [],
    );
    return searchSessions(sessions, request.query, request.limit);
  }

  private refresh(): Promise<void> {
    if (!this.scanning && Date.now() - this.scannedAt < this.rescanMs) {
      return Promise.resolve();
    }
    this.scanning ??= this.scan().finally(() => {
      this.scannedAt = Date.now();
      this.scanning = undefined;
    });
    return this.scanning;
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>();
    const folders = await readdir(this.projectsDir, { withFileTypes: true }).catch(() => []);
    for (const folder of folders) {
      if (!folder.isDirectory()) {
        continue;
      }
      const dir = path.join(this.projectsDir, folder.name);
      const names = await readdir(dir).catch((): string[] => []);
      for (const name of names) {
        if (!name.endsWith('.jsonl')) {
          continue;
        }
        const file = path.join(dir, name);
        const known = this.entries.get(file);
        const read = await readAppended(file, known);
        if (read === undefined) {
          continue;
        }
        seen.add(file);
        if (read === 'unchanged') {
          continue;
        }
        const sessionId = name.slice(0, -'.jsonl'.length);
        const reader = known && !read.restarted ? known.reader : new TranscriptReader();
        reader.add(read.text);
        const session = indexSession(sessionId, reader.transcript, read.mtimeMs, await sideTitle(path.join(dir, sessionId)));
        this.entries.set(file, { mtimeMs: read.mtimeMs, size: read.size, offset: read.offset, reader, session });
      }
    }
    for (const file of this.entries.keys()) {
      if (!seen.has(file)) {
        this.entries.delete(file);
      }
    }
  }
}

/** A name given to a session from outside its CLI process: `<session dir>/custom-title.json`. */
export async function sideTitle(sessionDir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(sessionDir, 'custom-title.json'), 'utf8'));
    const title = typeof parsed === 'object' && parsed !== null ? (parsed as { customTitle?: unknown }).customTitle : undefined;
    return typeof title === 'string' && title.trim() ? title : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where Claude Code keeps its transcripts (`CLAUDE_CONFIG_DIR` moves its whole folder).
 * `VILAUS_SESSIONS_DIR` points the search elsewhere, for tests.
 */
export function claudeProjectsDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.VILAUS_SESSIONS_DIR || path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
}

/**
 * Main's side of the sessions worker (sessionSearchWorker.ts), started on the first question:
 * searches, the usage of API providers (sessionUsage.ts), and full transcripts (fullTranscripts.ts).
 */
export class SessionSearch implements IDisposable {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();

  constructor(
    private readonly workerScript: string,
    private readonly projectsDir: string,
    /** The sessions' provider tags (sessionProviders.ts). */
    private readonly tagsFile: string,
    /** The calls kept after their transcripts are gone (usageLedger.ts). */
    private readonly ledgerFile: string,
    private readonly logger: ILogger,
  ) {}

  async search(request: SessionSearchRequest): Promise<SessionSearchResult[]> {
    return ((await this.ask('search', request)) as SessionSearchResult[] | undefined) ?? [];
  }

  async usage<K extends UsageRequest['kind']>(request: Extract<UsageRequest, { kind: K }>): Promise<UsageResults[K]> {
    return (await this.ask('usage', request)) as UsageResults[K];
  }

  /** Writes a session's full transcript as Markdown; its path, or undefined when the session is not found. */
  async fullTranscript(request: FullTranscriptRequest): Promise<string | undefined> {
    return ((await this.ask('transcript', request)) as string | null | undefined) ?? undefined;
  }

  /** How much room the sessions take on disk. */
  async storage(): Promise<SessionStorageDto> {
    return (await this.ask('storage', undefined)) as SessionStorageDto;
  }

  /** What the transcripts tell for the statistics page (sessionStats.ts). */
  async stats<K extends StatsRequest['kind']>(request: Extract<StatsRequest, { kind: K }>): Promise<StatsResults[K]> {
    return (await this.ask('stats', request)) as StatsResults[K];
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = undefined;
  }

  private ask(kind: 'search' | 'usage' | 'transcript' | 'storage' | 'stats', request: unknown): Promise<unknown> {
    const worker = (this.worker ??= this.start());
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, kind, request });
    });
  }

  private start(): Worker {
    const worker = new Worker(this.workerScript, {
      workerData: { projectsDir: this.projectsDir, tagsFile: this.tagsFile, ledgerFile: this.ledgerFile },
    });
    // Quitting need not wait for it.
    worker.unref();
    worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        request?.reject(new Error(message.error));
      } else {
        request?.resolve(message.result);
      }
    });
    worker.on('error', (error) => this.logger.error('session search worker failed', error));
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.worker = undefined;
      }
      for (const request of this.pending.values()) {
        request.reject(new Error(`session search worker exited (${code})`));
      }
      this.pending.clear();
    });
    return worker;
  }
}
