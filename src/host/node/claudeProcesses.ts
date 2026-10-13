/**
 * The Claude Code processes that run: each keeps a record of itself while it runs,
 * `<Claude Code folder>/sessions/<pid>.json` (`{pid, sessionId, ...}`), and removes it as it ends
 * (looked at with Claude Code 2.1.296). It removes it before its last writes to the session's
 * transcript, though: what must wait for those (deleting the session) waits for the process.
 */

import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Whether a process runs; one this user may not signal (an administrator's) runs too. */
export function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The Claude Code processes that run `sessionId` now, by the records under `configDir`. A
 * record whose process is gone was left behind by a crash and does not count.
 */
export async function sessionProcesses(configDir: string, sessionId: string, runs = processRuns): Promise<number[]> {
  const dir = path.join(configDir, 'sessions');
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const name of names.filter((entry) => /^\d+\.json$/.test(entry))) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as { pid?: unknown; sessionId?: unknown };
      if (record.sessionId === sessionId && typeof record.pid === 'number' && runs(record.pid)) {
        pids.push(record.pid);
      }
    } catch {
      // Being written or removed right now.
    }
  }
  return pids;
}

/** Waits until none of `pids` runs; false when one still does after `timeoutMs`. */
export async function waitForExit(pids: readonly number[], timeoutMs: number, runs = processRuns, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some((pid) => runs(pid))) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(intervalMs);
  }
  return true;
}
