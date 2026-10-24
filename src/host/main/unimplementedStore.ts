/**
 * `extensions/unimplemented.json`: which unimplemented VS Code API members each version of
 * the Claude Code extension used, and whether the user muted each. The normal and the
 * administrator instance share the file, so changes are made to it as it is on disk, one
 * change at a time (as ExtensionStore does for state.json). No Electron here.
 */

import * as fs from 'node:fs';
import {
  muteUnimplementedVersion,
  parseUnimplementedRecord,
  recordUnimplementedMember,
  type UnimplementedRecord,
} from '../../platform/extensionUnimplemented';
import type { ILogger } from '../../platform/log';
import { readJsonFile, writeFileAtomic } from '../node/jsonFile';

export class UnimplementedStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly logger: ILogger,
  ) {}

  /** The record as it is on disk now. */
  read(): UnimplementedRecord {
    return parseUnimplementedRecord(readJsonFile(this.file, undefined));
  }

  /** Adds `member` to `version`'s record (a no-op when it is already there). */
  record(version: string, member: string): void {
    void this.update((record) => recordUnimplementedMember(record, version, member));
  }

  /** A managed version activated: give it an (empty) record so the next version has a baseline. */
  ensureRecorded(version: string): void {
    void this.update((record) => (record[version] === undefined ? { ...record, [version]: { members: [] } } : undefined));
  }

  /** The user chose not to hear about `version` again. */
  mute(version: string): void {
    void this.update((record) => muteUnimplementedVersion(record, version));
  }

  /** Changes the record as it is on disk now (the other instance may have changed it), one at a time. */
  private update(change: (record: UnimplementedRecord) => UnimplementedRecord | undefined): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const onDisk = fs.existsSync(this.file) ? parseUnimplementedRecord(readJsonFile(this.file, undefined)) : {};
      const next = change(onDisk);
      if (next !== undefined) {
        await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      }
    });
    // A failed write must not fail the ones queued after it.
    this.writeQueue = run.catch((error: unknown) => this.logger.warn('writing unimplemented.json failed', error));
    return run;
  }
}
