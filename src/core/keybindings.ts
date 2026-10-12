/**
 * Keybindings. Rules map a chord to a command. The set of chords is mirrored to main,
 * which intercepts them before any page (including webview iframes) sees the key, and
 * sends them back here for dispatch. That way shortcuts work wherever focus is.
 *
 * Two layers, as in VS Code: the defaults that modules register, and the user's
 * keybindings.json (main reads and watches it), whose entries add rules and remove defaults.
 */

import { Emitter, type Event } from '../platform/event';
import type { IDisposable } from '../platform/lifecycle';
import type { ILogger } from '../platform/log';
import { formatChord, normalizeChord, type KeybindingEntry } from '../platform/keybindings';
import type { CommandService } from './commands';
import type { ContextKeyService } from './contextKeys';

export interface KeybindingRule {
  /** e.g. `ctrl+shift+p`; see platform/keybindings.ts for the key names. */
  readonly key: string;
  readonly command: string;
  readonly args?: readonly unknown[];
  readonly when?: string;
}

export interface ResolvedKeybinding extends KeybindingRule {
  readonly source: 'default' | 'user';
  /** A user rule's entry in keybindings.json, as written there. */
  readonly entry?: KeybindingEntry;
}

/**
 * The rules in force, lowest priority first: the defaults that no entry removes, then the
 * entries' own rules in file order (a later one wins, as in VS Code).
 */
export function resolveKeybindings(defaults: readonly KeybindingRule[], entries: readonly KeybindingEntry[]): ResolvedKeybinding[] {
  const removals = entries.filter((entry) => entry.command.startsWith('-'));
  const removed = (rule: KeybindingRule): boolean =>
    removals.some(
      (removal) =>
        removal.command.slice(1) === rule.command &&
        (removal.key.trim() === '' || normalizeChord(removal.key) === rule.key) &&
        (removal.when === undefined || removal.when.trim() === (rule.when ?? '').trim()),
    );
  const kept: ResolvedKeybinding[] = defaults.filter((rule) => !removed(rule)).map((rule) => ({ ...rule, source: 'default' }));
  const added: ResolvedKeybinding[] = entries
    .filter((entry) => !entry.command.startsWith('-'))
    .map((entry) => ({
      key: normalizeChord(entry.key),
      command: entry.command,
      ...(entry.when !== undefined ? { when: entry.when } : {}),
      ...(entry.args !== undefined ? { args: [entry.args] } : {}),
      source: 'user',
      entry,
    }));
  return [...kept, ...added];
}

export class KeybindingService {
  private readonly defaults: KeybindingRule[] = [];
  private userEntries: readonly KeybindingEntry[] = [];
  private rules: readonly ResolvedKeybinding[] = [];
  private pauses = 0;
  private updateScheduled = false;
  private readonly changeEmitter = new Emitter<void>();
  /** The rules changed: a module registered some, or keybindings.json changed. */
  readonly onDidChange: Event<void> = this.changeEmitter.event;
  /** keybindings.json on disk. */
  filePath = '';

  constructor(
    private readonly commands: CommandService,
    private readonly contextKeys: ContextKeyService,
    private readonly syncChords: (chords: string[]) => void,
    private readonly logger: ILogger,
  ) {}

  register(rule: KeybindingRule): IDisposable {
    const normalized = { ...rule, key: normalizeChord(rule.key) };
    this.defaults.push(normalized);
    this.update();
    return {
      dispose: () => {
        const index = this.defaults.indexOf(normalized);
        if (index >= 0) {
          this.defaults.splice(index, 1);
          this.update();
        }
      },
    };
  }

  /** The entries of keybindings.json (read and watched by main). */
  setUserEntries(entries: readonly KeybindingEntry[]): void {
    this.userEntries = entries;
    this.update();
  }

  get entries(): readonly KeybindingEntry[] {
    return this.userEntries;
  }

  /** The rules in force, lowest priority first. */
  get all(): readonly ResolvedKeybinding[] {
    return this.rules;
  }

  /** What modules registered, whatever keybindings.json does to it. */
  get defaultRules(): readonly KeybindingRule[] {
    return this.defaults;
  }

  /** Runs the last matching rule whose when clause holds. Returns true if one ran. */
  async dispatch(chord: string): Promise<boolean> {
    const key = normalizeChord(chord);
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i]!;
      if (rule.key !== key || !this.evaluate(rule.when) || !this.commands.isEnabled(rule.command)) {
        continue;
      }
      try {
        await this.commands.execute(rule.command, ...(rule.args ?? []));
      } catch (error) {
        this.logger.error(`keybinding ${key} -> ${rule.command} failed`, error);
      }
      return true;
    }
    return false;
  }

  /**
   * Display label for a command's keybinding, e.g. `Ctrl+Shift+P`: the user's latest, else
   * the first default (the one VS Code shows too, for commands with several).
   */
  labelFor(commandId: string): string | undefined {
    const rules = this.rules.filter((rule) => rule.command === commandId && !rule.args);
    const rule = rules.findLast((candidate) => candidate.source === 'user') ?? rules[0];
    return rule ? formatChord(rule.key) : undefined;
  }

  /** `title (Ctrl+B)`, or the title alone when the command has no keybinding. */
  tooltip(title: string, commandId: string): string {
    const label = this.labelFor(commandId);
    return label ? `${title} (${label})` : title;
  }

  /** Keeps `element`'s tooltip `title (key)` current: it is set again whenever the pointer comes over it. */
  bindTooltip(element: HTMLElement, title: string, commandId: string): void {
    const update = (): void => {
      element.title = this.tooltip(title, commandId);
    };
    update();
    element.addEventListener('pointerenter', update);
  }

  /** Main stops taking chords until disposed: a new one is being recorded. */
  pauseInterception(): IDisposable {
    this.pauses++;
    this.syncChords([]);
    let disposed = false;
    return {
      dispose: () => {
        if (!disposed) {
          disposed = true;
          this.pauses--;
          this.sync();
        }
      },
    };
  }

  private evaluate(when: string | undefined): boolean {
    try {
      return this.contextKeys.evaluate(when);
    } catch (error) {
      // A malformed clause in keybindings.json: that rule never applies.
      this.logger.warn(`keybinding when clause: ${String(error)}`);
      return false;
    }
  }

  private update(): void {
    // At once, for a label asked right after registering; main and listeners hear once per burst.
    this.rules = resolveKeybindings(this.defaults, this.userEntries);
    if (this.updateScheduled) {
      return;
    }
    this.updateScheduled = true;
    queueMicrotask(() => {
      this.updateScheduled = false;
      this.sync();
      this.changeEmitter.fire();
    });
  }

  private sync(): void {
    if (this.pauses === 0) {
      this.syncChords([...new Set(this.rules.map((rule) => rule.key))]);
    }
  }
}
