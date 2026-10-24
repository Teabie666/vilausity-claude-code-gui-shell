/**
 * How much room Claude Code's sessions take: the transcripts under `projects/<folder>/` and
 * what is kept next to each (`<session id>/`: subagents, tool output). Read in the sessions
 * worker: a heavy user has hundreds of MB in thousands of files.
 */

import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionStorageDto } from '../../platform/protocol';

/** The size of everything under `dir`, folders within it too. */
async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sizeOf(entryPath);
    } else if (entry.isFile()) {
      total += (await stat(entryPath).catch(() => undefined))?.size ?? 0;
    }
  }
  return total;
}

export async function sessionStorage(projectsDir: string): Promise<SessionStorageDto> {
  let sessions = 0;
  for (const folder of await readdir(projectsDir, { withFileTypes: true }).catch(() => [])) {
    if (folder.isDirectory()) {
      const names = await readdir(path.join(projectsDir, folder.name)).catch((): string[] => []);
      sessions += names.filter((name) => name.endsWith('.jsonl')).length;
    }
  }
  return { folder: projectsDir, sessions, bytes: await sizeOf(projectsDir) };
}
