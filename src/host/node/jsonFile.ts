/** Reading and atomically writing JSON files. */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // A corrupt file is kept aside rather than silently overwritten.
      try {
        fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        // Ignore: we fall back either way.
      }
    }
    return fallback;
  }
}

/**
 * A file another process owns, only read: undefined when there is none; throws when it
 * cannot be read or parsed now, and leaves it as it is.
 */
export function readOthersJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Waits before each retry of a rename. On Windows, replacing a file fails (EPERM, EACCES,
 * EBUSY) while another process has it open: a reader, an antivirus scan, a sync client.
 * It is retried for a moment, as graceful-fs does.
 */
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640];

let tempCounter = 0;

function tempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${++tempCounter}.tmp`;
}

function isBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/** Write to a temp file then rename, so a crash mid-write never leaves a truncated file. */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temp = tempPath(filePath);
  await fs.promises.writeFile(temp, contents, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(temp, filePath);
      return;
    } catch (error) {
      if (!isBusy(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        await fs.promises.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export function writeFileAtomicSync(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = tempPath(filePath);
  fs.writeFileSync(temp, contents, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temp, filePath);
      return;
    } catch (error) {
      if (!isBusy(error) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      // Used on quit, when nothing async runs any more.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}
