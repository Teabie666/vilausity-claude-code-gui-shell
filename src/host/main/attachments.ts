/**
 * Files dropped onto the session list or the search box are mentioned in the conversation by
 * their place in the workspace. Those outside it are copied into a folder of the workspace
 * first (`vilaus.conversations.attachmentsFolder`, created when missing), under a name free
 * there ("notes (1).txt" when "notes.txt" is taken); folders are copied whole.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILogger } from '../../platform/log';

/** Where copies go when the setting names no folder inside the workspace. */
export const DEFAULT_ATTACHMENTS_FOLDER = 'attachments';

/** The folder copies go into: `subfolder` of `workspace`, unless it leads out of it. */
export function attachmentsFolder(workspace: string, subfolder: string): string {
  const inside = (folder: string): string | undefined => {
    const target = path.resolve(workspace, folder);
    const relative = path.relative(workspace, target);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? target : undefined;
  };
  return inside(subfolder.trim()) ?? path.join(workspace, DEFAULT_ATTACHMENTS_FOLDER);
}

/** `name`, or `name (1)`, `name (2)`... (before a file's extension) when it is taken. */
export function freeName(name: string, isFolder: boolean, taken: (candidate: string) => boolean): string {
  if (!taken(name)) {
    return name;
  }
  const { name: stem, ext } = isFolder ? { name, ext: '' } : path.parse(name);
  for (let count = 1; ; count++) {
    const candidate = `${stem} (${count})${ext}`;
    if (!taken(candidate)) {
      return candidate;
    }
  }
}

function isInside(file: string, folder: string): boolean {
  const relative = path.relative(folder, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Where each of `paths` is in the workspace: as it is when inside it, else its copy in the
 * attachments folder. Paths that could not be copied (gone, unreadable) are `failed`.
 */
export async function placeInWorkspace(
  paths: readonly string[],
  workspace: string,
  subfolder: string,
  logger: ILogger,
): Promise<{ placed: string[]; failed: string[] }> {
  const placed: string[] = [];
  const failed: string[] = [];
  const folder = attachmentsFolder(workspace, subfolder);
  for (const source of paths) {
    if (isInside(source, workspace)) {
      placed.push(source);
      continue;
    }
    try {
      const stats = await fs.promises.stat(source);
      await fs.promises.mkdir(folder, { recursive: true });
      const name = freeName(path.basename(source), stats.isDirectory(), (candidate) => fs.existsSync(path.join(folder, candidate)));
      const target = path.join(folder, name);
      await fs.promises.cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      placed.push(target);
    } catch (error) {
      logger.warn(`cannot copy ${source} into ${folder}`, error);
      failed.push(source);
    }
  }
  return { placed, failed };
}
