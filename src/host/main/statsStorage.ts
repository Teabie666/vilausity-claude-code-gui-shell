/**
 * How much room the statistics page's kinds of files take on disk (`platform/stats.ts`): the
 * bytes and file count of everything under each directory, recursively. `shellData` walks the
 * data directory and leaves out the directories counted as the other items, so nothing is
 * counted twice. Missing directories are simply not listed.
 */

import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { StorageItem, StorageItemId } from '../../platform/stats';
import { normalizeForCompare } from '../node/paths';

export interface StorageTarget {
  readonly id: StorageItemId;
  /** The directory shown as the item's path (and counted, unless `dirs` says otherwise). */
  readonly path: string;
  /** The directories whose files count, instead of `path` (the cache subdirectories). */
  readonly dirs?: readonly string[];
  /** Directories skipped while walking (the `shellData` remainder). */
  readonly except?: readonly string[];
}

interface Measurement {
  readonly bytes: number;
  readonly files: number;
}

/** The bytes and file count of everything under `dir`; undefined when it is not a directory. */
async function measure(dir: string, except: ReadonlySet<string> | undefined): Promise<Measurement | undefined> {
  if (except?.has(normalizeForCompare(dir))) {
    return undefined;
  }
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) {
    return undefined;
  }
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await measure(entryPath, except);
      if (sub) {
        bytes += sub.bytes;
        files += sub.files;
      }
    } else if (entry.isFile()) {
      bytes += (await stat(entryPath).catch(() => undefined))?.size ?? 0;
      files += 1;
    }
  }
  return { bytes, files };
}

/** One item per target whose directories exist, with the room everything under them takes. */
export async function storageItems(targets: readonly StorageTarget[]): Promise<StorageItem[]> {
  const items: StorageItem[] = [];
  for (const target of targets) {
    const except = target.except && target.except.length > 0 ? new Set(target.except.map(normalizeForCompare)) : undefined;
    const dirs = target.dirs ?? [target.path];
    let bytes = 0;
    let files = 0;
    let found = false;
    for (const dir of dirs) {
      const measured = await measure(dir, except);
      if (measured) {
        bytes += measured.bytes;
        files += measured.files;
        found = true;
      }
    }
    if (found) {
      items.push({ id: target.id, path: target.path, bytes, files });
    }
  }
  return items;
}
