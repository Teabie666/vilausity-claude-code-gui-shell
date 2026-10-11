/**
 * Searching Claude Code's sessions (`sessions.search`). The transcripts are read in a worker
 * thread (sessionSearchWorker.ts): the first read goes through every transcript (hundreds of
 * MB for a heavy user), and main must stay responsive. The index keeps what it read, keyed
 * by each file's size and modification time, and rereads only what changed.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { SessionSearchRequest, SessionSearchResult } from '../../platform/protocol';
import { normalizeForCompare } from '../node/paths';
import { indexSession, parseTranscript, searchSessions, type IndexedSession } from './sessionTranscripts';

/** A search sooner than this after the last look at the files uses what is indexed. */
const RESCAN_MS = 3000;

interface Entry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly session: IndexedSession | undefined;
}

/** The index itself; lives in the worker. */
export class SessionIndex {
  private readonly entries = new Map<string, Entry>();
  private scannedAt = 0;
  private scanning: Promise<void> | undefined;

  constructor(private readonly projectsDir: string) {}

  async search(request: SessionSearchRequest): Promise<SessionSearchResult[]> {
    await this.refresh();
    const folder = request.folder === undefined ? undefined : normalizeForCompare(request.folder);
    const sessions = [...this.entries.values()].flatMap((entry) =>
      entry.session && (folder === undefined || normalizeForCompare(entry.session.folder) === folder) ? [entry.session] : [],
    );
    return searchSessions(sessions, request.query, request.limit);
  }

  private refresh(): Promise<void> {
    if (!this.scanning && Date.now() - this.scannedAt < RESCAN_MS) {
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
        const stats = await stat(file).catch(() => undefined);
        if (!stats?.isFile()) {
          continue;
        }
        seen.add(file);
        const known = this.entries.get(file);
        if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) {
          continue;
        }
        const sessionId = name.slice(0, -'.jsonl'.length);
        const text = await readFile(file, 'utf8').catch(() => undefined);
        const session =
          text === undefined
            ? undefined
            : indexSession(sessionId, parseTranscript(text), stats.mtimeMs, await sideTitle(path.join(dir, sessionId)));
        this.entries.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, session });
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
async function sideTitle(sessionDir: string): Promise<string | undefined> {
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

/** Main's side: sends searches to the worker, started on the first one. */
export class SessionSearch implements IDisposable {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(results: SessionSearchResult[]): void; reject(error: Error): void }>();

  constructor(
    private readonly workerScript: string,
    private readonly projectsDir: string,
    private readonly logger: ILogger,
  ) {}

  search(request: SessionSearchRequest): Promise<SessionSearchResult[]> {
    const worker = (this.worker ??= this.start());
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, request });
    });
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = undefined;
  }

  private start(): Worker {
    const worker = new Worker(this.workerScript, { workerData: { projectsDir: this.projectsDir } });
    // Quitting need not wait for it.
    worker.unref();
    worker.on('message', (message: { id: number; results?: SessionSearchResult[]; error?: string }) => {
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        request?.reject(new Error(message.error));
      } else {
        request?.resolve(message.results ?? []);
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
