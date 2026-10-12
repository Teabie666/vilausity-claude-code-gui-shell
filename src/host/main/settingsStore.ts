/**
 * The user's settings.json (JSON with comments). Main is the only writer; the extension
 * host gets a snapshot at startup and change notifications afterwards.
 *
 * Keys are stored flat, the way VS Code's settings.json usually looks
 * (`"claudeCode.hideOnboarding": true`). Edits go through jsonc-parser so the user's
 * comments and formatting survive.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { Emitter, type Event } from '../../platform/event';
import { Disposable, toDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import { writeFileAtomic } from '../node/jsonFile';

export interface SettingsChange {
  readonly keys: readonly string[];
}

const FORMATTING = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

export class SettingsStore extends Disposable {
  private values: Record<string, unknown> = {};
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly changeEmitter = this.register(new Emitter<SettingsChange>());
  readonly onDidChange: Event<SettingsChange> = this.changeEmitter.event;

  constructor(
    readonly filePath: string,
    private readonly logger: ILogger,
  ) {
    super();
    this.ensureFile();
    this.values = this.readFromDisk();
  }

  /** An empty settings.json from the start, so it can be opened in the editor and watched. */
  private ensureFile(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, '{\n}\n', 'utf8');
      }
    } catch (error) {
      this.logger.warn(`cannot create ${this.filePath}`, error);
    }
  }

  get all(): Readonly<Record<string, unknown>> {
    return this.values;
  }

  /** Sets or (with `undefined`) removes one top-level key. */
  set(key: string, value: unknown): Promise<void> {
    const write = this.writeQueue.then(async () => {
      let text = '';
      try {
        text = await fs.promises.readFile(this.filePath, 'utf8');
      } catch {
        text = '{}';
      }
      if (text.trim() === '') {
        text = '{}';
      }
      const edits = modify(text, [key], value, { formattingOptions: FORMATTING });
      await writeFileAtomic(this.filePath, applyEdits(text, edits));
      this.reload();
    });
    // A failed write must not fail the ones queued after it.
    this.writeQueue = write.catch(() => undefined);
    return write.catch((error: unknown) => {
      this.logger.error(`failed to write setting ${key}`, error);
      throw error;
    });
  }

  /** Picks up edits the user makes to settings.json by hand. */
  watch(): void {
    let timer: NodeJS.Timeout | undefined;
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(this.filePath, () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.reload(), 150);
      });
    } catch {
      // The file may not exist yet; it will be watched after the next start.
      return;
    }
    this.register(
      toDisposable(() => {
        clearTimeout(timer);
        watcher?.close();
      }),
    );
  }

  private reload(): void {
    const next = this.readFromDisk();
    const keys = new Set([...Object.keys(this.values), ...Object.keys(next)]);
    const changed = [...keys].filter((key) => JSON.stringify(this.values[key]) !== JSON.stringify(next[key]));
    this.values = next;
    if (changed.length > 0) {
      this.changeEmitter.fire({ keys: changed });
    }
  }

  private readFromDisk(): Record<string, unknown> {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return {};
    }
    const errors: ParseError[] = [];
    const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      this.logger.warn(`settings.json has ${errors.length} syntax error(s); using what parsed`);
    }
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  }
}
