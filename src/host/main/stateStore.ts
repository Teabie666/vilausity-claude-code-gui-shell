/**
 * Key/value state persisted as JSON: backs the extension's `globalState` and
 * `workspaceState` Mementos. Writes are debounced and atomic.
 */

import { readJsonFile, writeFileAtomic, writeFileAtomicSync } from '../node/jsonFile';
import type { ILogger } from '../../platform/log';

const WRITE_DELAY_MS = 300;

export class StateStore {
  private readonly values: Record<string, unknown>;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly logger: ILogger,
  ) {
    const loaded = readJsonFile<unknown>(filePath, {});
    this.values = loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded) ? (loaded as Record<string, unknown>) : {};
  }

  get snapshot(): Readonly<Record<string, unknown>> {
    return { ...this.values };
  }

  get(key: string): unknown {
    return this.values[key];
  }

  /** `undefined` deletes the key, matching `Memento.update`. */
  set(key: string, value: unknown): void {
    if (value === undefined) {
      delete this.values[key];
    } else {
      this.values[key] = value;
    }
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), WRITE_DELAY_MS);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.dirty) {
      return this.writing;
    }
    this.dirty = false;
    const contents = JSON.stringify(this.values, null, 2);
    this.writing = this.writing
      .then(() => writeFileAtomic(this.filePath, contents))
      .catch((error: unknown) => this.logger.error(`failed to write ${this.filePath}`, error));
    return this.writing;
  }

  flushSync(): void {
    clearTimeout(this.timer);
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    try {
      writeFileAtomicSync(this.filePath, JSON.stringify(this.values, null, 2));
    } catch (error) {
      this.logger.error(`failed to write ${this.filePath}`, error);
    }
  }
}
