/**
 * The keyboard shortcuts table at the top of its section in the settings, after VS Code's
 * keybindings editor: every shell keybinding, the commands that have none (to give them one),
 * then the built-in keys that cannot be changed. Double-click (or the pencil) records new
 * keys; changes go to keybindings.json the way VS Code writes them (see edits.ts).
 */

import type { CommandService } from '../../core/commands';
import type { Dialogs } from '../../core/dialogs';
import type { KeybindingService, ResolvedKeybinding } from '../../core/keybindings';
import type { SettingsWidgetHandle } from '../../core/settings';
import { formatChord, normalizeChord } from '../../platform/keybindings';
import type { ILogger } from '../../platform/log';
import { builtinKeybindings } from './builtins';
import { changeKeybinding, removeKeybinding, resetKeybindings, type KeybindingEdit } from './edits';
import { t } from './messages';
import { recordKeybinding, renderChord } from './recorder';

export interface ShortcutsTableContext {
  readonly keybindings: KeybindingService;
  readonly commands: CommandService;
  readonly dialogs: Dialogs;
  /** Writes to keybindings.json. */
  readonly edit: (edit: KeybindingEdit) => Promise<void>;
  readonly openJson: () => void;
  readonly logger: ILogger;
}

export interface ShortcutRow {
  /** The shell command; undefined for a built-in key. */
  readonly command?: string;
  readonly title: string;
  readonly key?: string;
  readonly when?: string;
  readonly source: string;
  readonly rule?: ResolvedKeybinding;
  /** keybindings.json adds to or removes from this command. */
  readonly modified: boolean;
}

/** `Category: Title`, or the command id when it has no title. */
export function commandTitle(commands: CommandService, id: string): string {
  const info = commands.info(id);
  if (!info?.title) {
    return id;
  }
  return info.category ? `${info.category}: ${info.title}` : info.title;
}

/** The rows: the keybindings in force, then commands without one, then built-in keys. */
export function shortcutRows(keybindings: KeybindingService, commands: CommandService): ShortcutRow[] {
  const modified = new Set(keybindings.entries.map((entry) => entry.command.replace(/^-/, '')));
  const byTitle = (a: ShortcutRow, b: ShortcutRow): number => a.title.localeCompare(b.title) || (a.key ?? '').localeCompare(b.key ?? '');
  const bound: ShortcutRow[] = keybindings.all.map((rule) => ({
    command: rule.command,
    title: commandTitle(commands, rule.command),
    key: rule.key,
    ...(rule.when !== undefined ? { when: rule.when } : {}),
    source: rule.source === 'user' ? t('sourceUser') : t('sourceDefault'),
    rule,
    modified: modified.has(rule.command),
  }));
  const boundCommands = new Set(keybindings.all.map((rule) => rule.command));
  const unbound: ShortcutRow[] = commands.all
    .filter((info) => info.title !== undefined && !boundCommands.has(info.id))
    .map((info) => ({ command: info.id, title: commandTitle(commands, info.id), source: '', modified: modified.has(info.id) }));
  const builtins: ShortcutRow[] = builtinKeybindings().map((builtin) => ({
    title: builtin.title,
    key: normalizeChord(builtin.key),
    when: builtin.where,
    source: builtin.source,
    modified: false,
  }));
  return [...bound.sort(byTitle), ...unbound.sort(byTitle), ...builtins];
}

/** What else runs on `chord` now, by title (built-in keys included); `except` is the row being changed. */
export function conflictsOf(rows: readonly ShortcutRow[], chord: string, except?: ShortcutRow): string[] {
  return [...new Set(rows.filter((row) => row !== except && row.key === chord).map((row) => row.title))];
}

function rowText(row: ShortcutRow): string {
  return [row.title, row.command ?? '', row.key ?? '', row.key ? formatChord(row.key) : '', row.when ?? '', row.source].join(' ').toLowerCase();
}

export function createShortcutsTable(container: HTMLElement, context: ShortcutsTableContext): SettingsWidgetHandle {
  const { keybindings, commands, dialogs } = context;
  container.classList.add('keybindings-widget');
  const toolbar = document.createElement('div');
  toolbar.className = 'keybindings-toolbar';
  const hint = document.createElement('span');
  hint.className = 'keybindings-hint';
  hint.textContent = t('hint');
  const openJson = document.createElement('a');
  openJson.className = 'setting-edit-json';
  openJson.href = '#';
  openJson.textContent = t('openJson');
  openJson.addEventListener('click', (event) => {
    event.preventDefault();
    context.openJson();
  });
  toolbar.append(hint, openJson);

  const table = document.createElement('table');
  table.className = 'keybindings-table';
  const head = table.createTHead().insertRow();
  for (const [name, className] of [
    ['', 'keybinding-actions'],
    [t('columnCommand'), 'keybinding-command'],
    [t('columnKeybinding'), 'keybinding-key'],
    [t('columnWhen'), 'keybinding-when'],
    [t('columnSource'), 'keybinding-source'],
  ] as const) {
    const cell = document.createElement('th');
    cell.className = className;
    cell.textContent = name;
    head.appendChild(cell);
  }
  const body = table.createTBody();
  container.append(toolbar, table);

  let rows: ShortcutRow[] = [];
  let words: readonly string[] = [];

  const write = (edit: KeybindingEdit): void => {
    context.edit(edit).catch((error: unknown) => {
      context.logger.error('changing keybindings.json failed', error);
      void dialogs.showMessage({ severity: 'error', modal: false, message: t('writeFailed'), items: [] });
    });
  };
  const change = async (row: ShortcutRow): Promise<void> => {
    if (!row.command) {
      return;
    }
    const chord = await recordKeybinding(dialogs, keybindings, {
      title: row.title,
      ...(row.key !== undefined ? { current: row.key } : {}),
      conflicts: (candidate) => conflictsOf(rows, candidate, row),
    });
    if (chord && chord !== row.key) {
      write(changeKeybinding(row.rule, row.command, chord));
    }
  };
  const iconButton = (icon: string, label: string, action: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.className = `icon-button ${icon}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      action();
    });
    button.addEventListener('dblclick', (event) => event.stopPropagation());
    return button;
  };

  const render = (): void => {
    rows = shortcutRows(keybindings, commands);
    body.replaceChildren(
      ...rows.map((row) => {
        const tr = document.createElement('tr');
        tr.className = 'keybinding-row';
        tr.classList.toggle('builtin', !row.command);
        tr.classList.toggle('modified', row.modified);
        if (row.command) {
          tr.dataset.command = row.command;
        }
        const actions = tr.insertCell();
        actions.className = 'keybinding-actions';
        const command = tr.insertCell();
        command.className = 'keybinding-command';
        command.textContent = row.title;
        command.title = row.command ?? row.title;
        const key = tr.insertCell();
        key.className = 'keybinding-key';
        if (row.key) {
          key.appendChild(renderChord(row.key));
        }
        const when = tr.insertCell();
        when.className = 'keybinding-when';
        when.textContent = row.when ?? '';
        when.title = row.when ?? '';
        const source = tr.insertCell();
        source.className = 'keybinding-source';
        const sourceContent = document.createElement('div');
        sourceContent.className = 'keybinding-source-content';
        const sourceText = document.createElement('span');
        sourceText.className = 'keybinding-source-text';
        sourceText.textContent = row.source;
        sourceContent.appendChild(sourceText);
        source.appendChild(sourceContent);
        if (row.command) {
          const edit = (): void => void change(row);
          actions.appendChild(row.key ? iconButton('icon-edit', t('change'), edit) : iconButton('icon-add', t('add'), edit));
          tr.addEventListener('dblclick', edit);
          const rowActions = document.createElement('span');
          rowActions.className = 'keybinding-row-actions';
          const command = row.command;
          if (row.modified) {
            rowActions.appendChild(iconButton('icon-discard', t('reset'), () => write(resetKeybindings(command, keybindings.entries))));
          }
          if (row.rule) {
            const rule = row.rule;
            rowActions.appendChild(iconButton('icon-close', t('remove'), () => write(removeKeybinding(rule))));
          }
          sourceContent.appendChild(rowActions);
        }
        tr.hidden = !words.every((word) => rowText(row).includes(word));
        return tr;
      }),
    );
  };
  render();
  // Commands come and go too (the extension host's, a reconnect).
  const subscriptions = [keybindings.onDidChange(render), commands.onDidChange(render)];

  return {
    search: (query) => {
      words = query;
      render();
      return rows.filter((row) => words.every((word) => rowText(row).includes(word))).length;
    },
    dispose: () => subscriptions.forEach((subscription) => subscription.dispose()),
  };
}
