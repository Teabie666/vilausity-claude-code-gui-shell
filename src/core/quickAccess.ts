/**
 * Quick access, after VS Code's: one input over the window whose leading characters pick a
 * provider (`>`: commands; none: search). The search is made of groups that modules
 * contribute (conversations, files, folders...). A group that answers asynchronously keeps
 * its previous rows until the new ones arrive, so the list does not flicker while typing,
 * or shows what its contributor offers meanwhile (its rows of last time, when the picker
 * opens: the group takes its place at once and the others do not move when it answers);
 * an Enter pressed before they arrive waits for them, so typing a name and Enter opens the
 * first match rather than whatever row was there a moment before.
 */

import { CancellationTokenSource, type CancellationToken } from '../platform/cancellation';
import type { IDisposable } from '../platform/lifecycle';
import type { ILogger } from '../platform/log';
import type { Dialogs } from './dialogs';
import { t } from './messages';

/** `[start, end)` of a match in a label or detail. */
export type Highlight = readonly [number, number];

export interface QuickAccessItem {
  /** Names the row across answers: the cursor stays on it when its group answers again. */
  readonly id?: string;
  readonly label: string;
  readonly labelHighlights?: readonly Highlight[];
  /** Dimmed, after the label. */
  readonly description?: string;
  /** A second line. */
  readonly detail?: string;
  readonly detailHighlights?: readonly Highlight[];
  /** Right-aligned, e.g. a command's keybinding. */
  readonly keybinding?: string;
  /** An icon of styles.css (`--icon-<name>`). */
  readonly icon?: string;
  /** Runs once the picker has closed; `alternate` is Ctrl+Enter or Ctrl+click. */
  accept(alternate: boolean): unknown;
}

export interface QuickAccessGroup {
  /** Shown above the group's rows. */
  readonly label?: string;
  readonly items: readonly QuickAccessItem[];
}

export type QuickAccessResult = QuickAccessGroup | undefined;

/** A group in the making; `key` names it across queries (it keeps its rows while it answers). */
export interface QuickAccessSlot {
  readonly key: string;
  readonly result: QuickAccessResult | Promise<QuickAccessResult>;
  /** Shown until `result` answers, in place of the rows it had for the previous text. */
  readonly initial?: QuickAccessResult;
}

export interface QuickAccessProvider {
  /** The input's placeholder while this provider is active. */
  placeholder(): string;
  /** The groups for `query` (the input without the prefix, trimmed), in display order. */
  provide(query: string, token: CancellationToken): readonly QuickAccessSlot[];
}

/** One group of the search (the provider without a prefix). */
export interface SearchContributor {
  readonly id: string;
  /** Lower comes first; may depend on what was typed. */
  readonly order: number | ((query: string) => number);
  /** The picker opened: drop what was cached for the previous one. */
  onDidOpen?(): void;
  provide(query: string, token: CancellationToken): QuickAccessResult | Promise<QuickAccessResult>;
  /** What the group shows until `provide` answers (its answer of last time, say). */
  initial?(query: string): QuickAccessResult;
}

/** How long an Enter waits for the groups still answering before it takes the first row anyway. */
const ACCEPT_WAIT_MS = 2000;

function orderOf(contributor: SearchContributor, query: string): number {
  return typeof contributor.order === 'number' ? contributor.order : contributor.order(query);
}

interface Row {
  readonly item?: QuickAccessItem;
  readonly label?: string;
}

export class QuickAccess {
  private readonly providers = new Map<string, QuickAccessProvider>();
  private readonly contributors: SearchContributor[] = [];
  /** Replaces the open picker's text; set while one is open. */
  private setValue: ((value: string) => void) | undefined;

  constructor(
    private readonly dialogs: Dialogs,
    private readonly logger: ILogger,
  ) {
    this.providers.set('', {
      placeholder: () => t('searchPlaceholder'),
      provide: (query, token) =>
        [...this.contributors]
          .sort((a, b) => orderOf(a, query) - orderOf(b, query))
          .map((contributor) => ({
            key: contributor.id,
            result: contributor.provide(query, token),
            initial: contributor.initial?.(query),
          })),
    });
  }

  registerProvider(prefix: string, provider: QuickAccessProvider): IDisposable {
    this.providers.set(prefix, provider);
    return { dispose: () => this.providers.delete(prefix) };
  }

  registerSearchContributor(contributor: SearchContributor): IDisposable {
    this.contributors.push(contributor);
    return {
      dispose: () => {
        const index = this.contributors.indexOf(contributor);
        if (index >= 0) {
          this.contributors.splice(index, 1);
        }
      },
    };
  }

  get isOpen(): boolean {
    return this.setValue !== undefined;
  }

  /** Opens with `value` in the input (`>` opens the commands), or puts it in the open one. */
  show(value = ''): void {
    if (this.setValue) {
      this.setValue(value);
      return;
    }
    for (const contributor of this.contributors) {
      contributor.onDidOpen?.();
    }
    this.open(value);
  }

  private open(initialValue: string): void {
    const { box, finish } = this.dialogs.openOverlay<void>(
      () => {
        this.setValue = undefined;
        cancelDeferredAccept();
        tokenSource?.cancel();
        tokenSource?.dispose();
      },
      undefined,
      { quickInput: true },
    );
    const input = document.createElement('input');
    input.className = 'quick-input-filter';
    input.setAttribute('aria-label', t('quickAccess'));
    const list = document.createElement('div');
    list.className = 'quick-input-list';
    list.setAttribute('role', 'listbox');
    box.append(input, list);

    let prefix: string | undefined;
    let slots: { key: string; group: QuickAccessResult }[] = [];
    let rows: Row[] = [];
    /** The row the cursor is on; the first item until the user moves the cursor. */
    let focused: QuickAccessItem | undefined;
    let navigated = false;
    let generation = 0;
    let tokenSource: CancellationTokenSource | undefined;
    /** Groups still answering the current text. */
    let pending = 0;
    /**
     * Enter came before every group had answered (text typed and Enter pressed at once): the
     * first row is not known yet, so it is taken once they have, or after a while.
     */
    let deferredAccept: { alternate: boolean; timer: ReturnType<typeof setTimeout> } | undefined;
    const cancelDeferredAccept = (): void => {
      if (deferredAccept) {
        clearTimeout(deferredAccept.timer);
        deferredAccept = undefined;
      }
    };

    const render = (): void => {
      rows = [];
      for (const { group } of slots) {
        if (!group || group.items.length === 0) {
          continue;
        }
        if (group.label) {
          rows.push({ label: group.label });
        }
        rows.push(...group.items.map((item) => ({ item })));
      }
      const items = rows.flatMap((row) => (row.item ? [row.item] : []));
      const id = focused?.id;
      if (focused && !items.includes(focused) && id !== undefined) {
        // Its group answered again: the cursor stays on the same row.
        focused = items.find((item) => item.id === id) ?? focused;
      }
      if (!navigated || !focused || !items.includes(focused)) {
        focused = items[0];
      }
      list.replaceChildren(
        ...rows.map((row) => (row.item ? this.renderItem(row.item, row.item === focused, choose) : separator(row.label ?? ''))),
      );
      list.querySelector('.quick-input-item.focused')?.scrollIntoView({ block: 'nearest' });
    };

    const update = (): void => {
      const value = input.value;
      const nextPrefix =
        [...this.providers.keys()].filter((candidate) => candidate && value.startsWith(candidate)).sort((a, b) => b.length - a.length)[0] ??
        '';
      const provider = this.providers.get(nextPrefix)!;
      input.placeholder = provider.placeholder();
      const switched = nextPrefix !== prefix;
      prefix = nextPrefix;
      tokenSource?.cancel();
      tokenSource?.dispose();
      tokenSource = new CancellationTokenSource();
      const current = ++generation;
      navigated = false;
      // New text: an Enter pressed for the old one no longer applies.
      cancelDeferredAccept();
      pending = 0;
      const previous = new Map(switched ? [] : slots.map((slot) => [slot.key, slot.group]));
      let results: readonly QuickAccessSlot[];
      try {
        results = provider.provide(value.slice(nextPrefix.length).trim(), tokenSource.token);
      } catch (error) {
        this.logger.error('quick access provider failed', error);
        results = [];
      }
      const answered = (index: number, key: string, group: QuickAccessResult): void => {
        if (current !== generation) {
          return;
        }
        slots[index] = { key, group };
        pending--;
        render();
        if (pending === 0 && deferredAccept) {
          const { alternate } = deferredAccept;
          cancelDeferredAccept();
          choose(focused, alternate);
        }
      };
      slots = results.map(({ key, result, initial }, index) => {
        if (!(result instanceof Promise)) {
          return { key, group: result };
        }
        pending++;
        result.then(
          (group) => answered(index, key, group),
          (error: unknown) => {
            if (current === generation) {
              this.logger.error(`quick access group ${key} failed`, error);
            }
            answered(index, key, undefined);
          },
        );
        // Until it answers, the group shows what it offers meanwhile, else what it found for the previous text.
        return { key, group: initial ?? previous.get(key) };
      });
      render();
    };

    const move = (offset: number): void => {
      const items = rows.flatMap((row) => (row.item ? [row.item] : []));
      if (items.length === 0) {
        return;
      }
      const index = focused ? items.indexOf(focused) : 0;
      focused = items[(index + offset + items.length) % items.length];
      navigated = true;
      cancelDeferredAccept();
      render();
    };

    const choose = (item: QuickAccessItem | undefined, alternate: boolean): void => {
      if (!item) {
        return;
      }
      finish();
      Promise.resolve()
        .then(() => item.accept(alternate))
        .catch((error: unknown) => this.logger.error(`quick access item '${item.label}' failed`, error));
    };

    input.addEventListener('input', update);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        move(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (pending > 0 && !navigated) {
          const alternate = event.ctrlKey;
          deferredAccept ??= {
            alternate,
            timer: setTimeout(() => {
              cancelDeferredAccept();
              choose(focused, alternate);
            }, ACCEPT_WAIT_MS),
          };
        } else {
          choose(focused, event.ctrlKey);
        }
      }
    });
    this.setValue = (value) => {
      input.value = value;
      update();
      input.focus();
    };
    this.setValue(initialValue);
  }

  private renderItem(item: QuickAccessItem, focused: boolean, choose: (item: QuickAccessItem, alternate: boolean) => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'quick-input-item';
    row.setAttribute('role', 'option');
    row.classList.toggle('focused', focused);
    row.setAttribute('aria-selected', String(focused));
    if (item.icon) {
      const icon = document.createElement('span');
      icon.className = 'quick-input-icon';
      icon.style.setProperty('--icon', `var(--icon-${item.icon})`);
      row.classList.add('has-icon');
      row.appendChild(icon);
    }
    row.appendChild(highlighted('quick-input-label', item.label, item.labelHighlights));
    if (item.description) {
      const description = document.createElement('span');
      description.className = 'quick-input-description';
      description.textContent = item.description;
      row.appendChild(description);
    }
    if (item.keybinding) {
      const keybinding = document.createElement('kbd');
      keybinding.className = 'quick-input-keybinding';
      keybinding.textContent = item.keybinding;
      row.appendChild(keybinding);
    }
    if (item.detail) {
      row.appendChild(highlighted('quick-input-detail', item.detail, item.detailHighlights));
    }
    row.addEventListener('mousedown', (event) => {
      event.preventDefault();
      choose(item, event.ctrlKey);
    });
    return row;
  }
}

function separator(label: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'quick-input-separator';
  row.textContent = label;
  return row;
}

/** `text` with the `ranges` marked up for highlighting. */
function highlighted(className: string, text: string, ranges: readonly Highlight[] = []): HTMLElement {
  const element = document.createElement(className === 'quick-input-detail' ? 'div' : 'span');
  element.className = className;
  let at = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < at || end <= start || end > text.length) {
      continue;
    }
    const mark = document.createElement('span');
    mark.className = 'quick-input-highlight';
    mark.textContent = text.slice(start, end);
    element.append(text.slice(at, start), mark);
    at = end;
  }
  element.append(text.slice(at));
  return element;
}
