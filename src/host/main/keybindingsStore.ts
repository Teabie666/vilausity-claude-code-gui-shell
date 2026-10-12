/**
 * The user's keybindings.json (JSON with comments, VS Code's format: an array of `{key,
 * command, when?, args?}`). Main is the only writer; windows get the entries at startup and
 * again whenever the file changes, here or by hand. Edits go through jsonc-parser so the
 * user's comments and formatting survive.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { Emitter, type Event } from '../../platform/event';
import { parseKeybindingEntries, sameKeybindingEntry, type KeybindingEntry } from '../../platform/keybindings';
import { Disposable, toDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import { writeFileAtomic } from '../node/jsonFile';

const FORMATTING = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;
/** What VS Code puts in a new keybindings.json. */
const EMPTY_FILE = '// Place your key bindings in this file to override the defaults\n[\n]\n';

/**
 * `text` with the first entry equal to each of `remove` taken out and `add` appended. Text
 * that is not an array starts over as an empty one.
 */
export function editKeybindingsText(text: string, remove: readonly KeybindingEntry[], add: readonly KeybindingEntry[]): string {
  if (!Array.isArray(parse(text, [], { allowTrailingComma: true }))) {
    text = EMPTY_FILE;
  }
  const items: unknown[] = parse(text, [], { allowTrailingComma: true }) as unknown[];
  const indices = new Set<number>();
  for (const entry of remove) {
    const index = items.findIndex(
      (item, at) => !indices.has(at) && parseKeybindingEntries([item]).some((candidate) => sameKeybindingEntry(candidate, entry)),
    );
    if (index >= 0) {
      indices.add(index);
    }
  }
  // From the end, so the indices still to remove stay where they were.
  for (const index of [...indices].sort((a, b) => b - a)) {
    text = applyEdits(text, modify(text, [index], undefined, { formattingOptions: FORMATTING }));
  }
  for (const entry of add) {
    text = applyEdits(text, modify(text, [-1], entry, { formattingOptions: FORMATTING, isArrayInsertion: true }));
  }
  return text;
}

export class KeybindingsStore extends Disposable {
  private entryList: KeybindingEntry[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly changeEmitter = this.register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.changeEmitter.event;

  constructor(
    readonly filePath: string,
    private readonly logger: ILogger,
  ) {
    super();
    this.ensureFile();
    this.entryList = this.readFromDisk();
  }

  /** A keybindings.json from the start, so it can be opened in the editor and watched. */
  private ensureFile(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, EMPTY_FILE, 'utf8');
      }
    } catch (error) {
      this.logger.warn(`cannot create ${this.filePath}`, error);
    }
  }

  get entries(): readonly KeybindingEntry[] {
    return this.entryList;
  }

  /** Takes the entries equal to `remove` out and appends `add`. */
  edit(remove: readonly KeybindingEntry[], add: readonly KeybindingEntry[]): Promise<void> {
    const write = this.writeQueue.then(async () => {
      let text = EMPTY_FILE;
      try {
        text = await fs.promises.readFile(this.filePath, 'utf8');
      } catch {
        // Written anew.
      }
      await writeFileAtomic(this.filePath, editKeybindingsText(text, remove, add));
      this.reload();
    });
    // A failed write must not fail the ones queued after it.
    this.writeQueue = write.catch(() => undefined);
    return write.catch((error: unknown) => {
      this.logger.error('failed to write keybindings.json', error);
      throw error;
    });
  }

  /** Picks up edits the user makes to keybindings.json by hand. */
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
    if (JSON.stringify(next) !== JSON.stringify(this.entryList)) {
      this.entryList = next;
      this.changeEmitter.fire();
    }
  }

  private readFromDisk(): KeybindingEntry[] {
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const errors: ParseError[] = [];
    const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      this.logger.warn(`keybindings.json has ${errors.length} syntax error(s); using what parsed`);
    }
    return parseKeybindingEntries(parsed);
  }
}
