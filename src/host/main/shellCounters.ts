/**
 * Vilausity's own counts for the statistics page (`platform/stats.ts`), kept in
 * `<root>\state\counters.json` shared by the normal and the administrator instance, the way
 * recentFolders.ts shares its file. Counts accumulate: each process keeps its own increments
 * in memory and, at most once a second, merges them into the file — re-reading it first, since
 * the other process may have written since — and writes it back atomically (jsonFile.ts).
 *
 * What can still be lost: two processes that read the file in the same instant and both rename
 * their temp file over it (last writer wins). The read-then-rename window is tiny, and
 * jsonFile.ts retries the rename while the other process holds it, so a lost count needs both
 * to increment and flush in the same few milliseconds; on quit each process flushes first.
 */

import type { IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { ShellCounterName, ShellCounters as ShellCountersDto } from '../../platform/stats';
import { readJsonFile, writeFileAtomic, writeFileAtomicSync } from '../node/jsonFile';
import { normalizeForCompare } from '../node/paths';

/** A counter a plain `increment` adds to. */
type CounterName = ShellCounterName;

/** The file on disk: the counts, and the distinct folders `distinctFolders` is the length of. */
interface CountersFile {
  since: number;
  launches: number;
  foldersOpened: number;
  folders: string[];
  filesOpened: number;
  comments: number;
  filesDropped: number;
  searches: number;
  fullTranscripts: number;
  localApiCalls: number;
}

/** How long after a change the file is written; more changes in between add to the same write. */
const WRITE_DELAY_MS = 1000;

const COUNTER_NAMES: readonly CounterName[] = [
  'launches',
  'foldersOpened',
  'filesOpened',
  'comments',
  'filesDropped',
  'searches',
  'fullTranscripts',
  'localApiCalls',
];

function emptyCounts(): Record<CounterName, number> {
  return {
    launches: 0,
    foldersOpened: 0,
    filesOpened: 0,
    comments: 0,
    filesDropped: 0,
    searches: 0,
    fullTranscripts: 0,
    localApiCalls: 0,
  };
}

/** The counters as last read from disk (or empty: no file yet, or a corrupt one set aside). */
function readCounters(filePath: string): CountersFile {
  const value = readJsonFile<unknown>(filePath, undefined);
  const parsed = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const number = (key: string): number => {
    const n = parsed[key];
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  };
  const foldersRaw = parsed.folders;
  const folders = Array.isArray(foldersRaw)
    ? [...new Set(foldersRaw.filter((f): f is string => typeof f === 'string' && f.length > 0).map(normalizeForCompare))]
    : [];
  return {
    since: number('since'),
    launches: number('launches'),
    foldersOpened: number('foldersOpened'),
    folders,
    filesOpened: number('filesOpened'),
    comments: number('comments'),
    filesDropped: number('filesDropped'),
    searches: number('searches'),
    fullTranscripts: number('fullTranscripts'),
    localApiCalls: number('localApiCalls'),
  };
}

export class ShellCounters implements IDisposable {
  private base: CountersFile;
  /** When counting began; set on the first increment and then persisted. */
  private since: number;
  /** This process's increments not yet written. */
  private readonly delta = emptyCounts();
  /** The folders this process opened that the file does not yet hold (normalized). */
  private readonly folders = new Set<string>();
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly filePath: string,
    private readonly logger: ILogger,
  ) {
    this.base = readCounters(filePath);
    this.since = this.base.since;
  }

  /** Adds `by` to a counter (for files dropped: by their count). */
  increment(name: CounterName, by = 1): void {
    this.delta[name] += by;
    this.touch();
  }

  /** A window opened a folder: `foldersOpened` + 1, and `folder` as a distinct one. */
  folderOpened(folder: string): void {
    this.delta.foldersOpened += 1;
    const key = normalizeForCompare(folder);
    if (!this.base.folders.includes(key)) {
      this.folders.add(key);
    }
    this.touch();
  }

  /** The counts as they stand now, this process's unwritten increments included. */
  read(): ShellCountersDto {
    return {
      since: this.since || Date.now(),
      launches: this.base.launches + this.delta.launches,
      foldersOpened: this.base.foldersOpened + this.delta.foldersOpened,
      distinctFolders: new Set([...this.base.folders, ...this.folders]).size,
      filesOpened: this.base.filesOpened + this.delta.filesOpened,
      comments: this.base.comments + this.delta.comments,
      filesDropped: this.base.filesDropped + this.delta.filesDropped,
      searches: this.base.searches + this.delta.searches,
      fullTranscripts: this.base.fullTranscripts + this.delta.fullTranscripts,
      localApiCalls: this.base.localApiCalls + this.delta.localApiCalls,
    };
  }

  /** Writes the pending increments, merged with whatever is on disk now. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.dirty || this.disposed) {
      return this.writing;
    }
    const taken = this.take();
    this.writing = this.writing
      .then(async () => {
        const merged = ShellCounters.merge(readCounters(this.filePath), taken.delta, taken.folders, taken.since);
        await writeFileAtomic(this.filePath, JSON.stringify(merged, null, 2));
        this.base = merged;
      })
      .catch((error: unknown) => this.logger.error(`failed to write ${this.filePath}`, error));
    return this.writing;
  }

  /** Synchronous last-chance write, for an abrupt exit (shellApp.flushSync). */
  flushSync(): void {
    clearTimeout(this.timer);
    if (!this.dirty || this.disposed) {
      return;
    }
    const taken = this.take();
    try {
      const merged = ShellCounters.merge(readCounters(this.filePath), taken.delta, taken.folders, taken.since);
      writeFileAtomicSync(this.filePath, JSON.stringify(merged, null, 2));
      this.base = merged;
    } catch (error) {
      this.logger.error(`failed to write ${this.filePath}`, error);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  /** Marks this process's pending counts to be written and schedules the write. */
  private touch(): void {
    if (this.since === 0) {
      this.since = Date.now();
    }
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), WRITE_DELAY_MS);
  }

  /** Snapshot and clear the pending counts, so later increments start a fresh delta. */
  private take(): { delta: Record<CounterName, number>; folders: string[]; since: number } {
    this.dirty = false;
    const delta = { ...this.delta };
    for (const name of COUNTER_NAMES) {
      this.delta[name] = 0;
    }
    const folders = [...this.folders];
    this.folders.clear();
    const since = this.since;
    return { delta, folders, since };
  }

  /** `onDisk` plus the given pending counts, folder sets unified. */
  private static merge(onDisk: CountersFile, delta: Record<CounterName, number>, folders: readonly string[], since: number): CountersFile {
    return {
      since: onDisk.since || since,
      launches: onDisk.launches + delta.launches,
      foldersOpened: onDisk.foldersOpened + delta.foldersOpened,
      folders: [...new Set([...onDisk.folders, ...folders])],
      filesOpened: onDisk.filesOpened + delta.filesOpened,
      comments: onDisk.comments + delta.comments,
      filesDropped: onDisk.filesDropped + delta.filesDropped,
      searches: onDisk.searches + delta.searches,
      fullTranscripts: onDisk.fullTranscripts + delta.fullTranscripts,
      localApiCalls: onDisk.localApiCalls + delta.localApiCalls,
    };
  }
}
