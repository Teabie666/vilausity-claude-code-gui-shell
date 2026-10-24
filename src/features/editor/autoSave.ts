/**
 * `files.autoSave`, with VS Code's values: files with unsaved changes save themselves after
 * a delay (`afterDelay`), when their editor loses focus (`onFocusChange`, which also saves
 * when the window does), or when the window loses focus (`onWindowChange`). Off by default,
 * as in VS Code. Only files on disk: the extension reads the same setting to decide what
 * saving its own documents means (with it off, saving a proposed change accepts it).
 */

import type { IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { ModelEntry } from './textModels';

export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';

export const AUTO_SAVE_MODES: readonly AutoSaveMode[] = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'];
export const DEFAULT_AUTO_SAVE_DELAY_MS = 1000;

export interface AutoSaveHost {
  mode(): AutoSaveMode;
  delay(): number;
  /** The documents with unsaved changes now. */
  dirty(): readonly ModelEntry[];
  /** Saves through the extension host; false when it could not. */
  save(uri: string): Promise<boolean>;
  /** Saving failed (shown once until a save of that document works). */
  reportFailure(uri: string): void;
}

interface EntryState {
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Changed on disk while it had changes: saving would overwrite that, so only the user saves it. */
  conflicted: boolean;
  saving: boolean;
  failed: boolean;
}

export class AutoSave implements IDisposable {
  private readonly states = new WeakMap<ModelEntry, EntryState>();
  private readonly timed = new Set<ModelEntry>();

  constructor(
    private readonly host: AutoSaveHost,
    private readonly logger: ILogger,
  ) {}

  /** A document's text changed. */
  didChangeContent(entry: ModelEntry): void {
    const state = this.state(entry);
    if (this.host.mode() !== 'afterDelay' || !entry.isDirty || !savable(entry)) {
      return;
    }
    clearTimeout(state.timer);
    this.timed.add(entry);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.timed.delete(entry);
      void this.save(entry);
    }, this.host.delay());
  }

  /** The editor of `uri` lost focus (focus went elsewhere, or another tab became active). */
  didBlurEditor(uri: string | undefined): void {
    if (this.host.mode() !== 'onFocusChange' || !uri) {
      return;
    }
    const entry = this.host.dirty().find((candidate) => candidate.uri === uri);
    if (entry) {
      void this.save(entry);
    }
  }

  /** The window lost focus (to another program, not to a webview inside it). */
  didBlurWindow(): void {
    const mode = this.host.mode();
    if (mode !== 'onFocusChange' && mode !== 'onWindowChange') {
      return;
    }
    for (const entry of this.host.dirty()) {
      void this.save(entry);
    }
  }

  /** The setting changed: pending delays go; with a mode on, what is unsaved now saves by it. */
  didChangeMode(): void {
    for (const entry of this.timed) {
      clearTimeout(this.state(entry).timer);
      this.state(entry).timer = undefined;
    }
    this.timed.clear();
    if (this.host.mode() === 'afterDelay') {
      for (const entry of this.host.dirty()) {
        this.didChangeContent(entry);
      }
    }
  }

  dispose(): void {
    for (const entry of this.timed) {
      clearTimeout(this.state(entry).timer);
    }
    this.timed.clear();
  }

  private state(entry: ModelEntry): EntryState {
    let state = this.states.get(entry);
    if (!state) {
      const created: EntryState = { timer: undefined, conflicted: false, saving: false, failed: false };
      state = created;
      this.states.set(entry, created);
      // (The entry's events go with its model.)
      entry.onDidConflict(() => {
        created.conflicted = true;
      });
      entry.onDidChangeDirty((dirty) => {
        // Saved or reloaded: in step with the disk again.
        if (!dirty) {
          created.conflicted = false;
        }
      });
    }
    return state;
  }

  private async save(entry: ModelEntry): Promise<void> {
    const state = this.state(entry);
    if (!entry.isDirty || !savable(entry) || state.conflicted) {
      return;
    }
    if (state.saving) {
      // Edits made during the save get their own turn once it is done.
      this.didChangeContent(entry);
      return;
    }
    state.saving = true;
    try {
      const saved = await this.host.save(entry.uri);
      if (saved) {
        state.failed = false;
      } else if (!state.failed) {
        state.failed = true;
        this.host.reportFailure(entry.uri);
      }
    } catch (error) {
      this.logger.warn(`auto save of ${entry.uri} failed`, error);
    } finally {
      state.saving = false;
    }
  }
}

export function savable(entry: ModelEntry): boolean {
  return !entry.readOnly && entry.uri.startsWith('file:');
}

export function autoSaveMode(value: unknown): AutoSaveMode {
  return AUTO_SAVE_MODES.includes(value as AutoSaveMode) ? (value as AutoSaveMode) : 'off';
}
