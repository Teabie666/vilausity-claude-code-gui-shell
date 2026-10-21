/**
 * The recently opened folders, in a file of their own (`state/recent-folders.json` of the
 * normal instance) that the administrator instance reads and writes too: a folder opened
 * as administrator shows in the normal instance's list, and the other way round. Each
 * change reads the file first, since the other process may have written it since.
 */

import type { ILogger } from '../../platform/log';
import { readJsonFile, writeFileAtomicSync } from '../node/jsonFile';
import type { RecentFoldersFile } from './windowHistory';

export class SharedRecentFolders implements RecentFoldersFile {
  constructor(
    private readonly filePath: string,
    private readonly logger: ILogger,
  ) {}

  read(): string[] {
    const value = readJsonFile<unknown>(this.filePath, []);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  }

  write(folders: readonly string[]): void {
    try {
      writeFileAtomicSync(this.filePath, JSON.stringify(folders, null, 2));
    } catch (error) {
      this.logger.error(`failed to write ${this.filePath}`, error);
    }
  }
}
