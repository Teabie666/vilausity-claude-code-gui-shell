/**
 * Command palette: quick access after `>` (Ctrl+Shift+P, F1): every titled, enabled shell
 * command, the recently used first (as in VS Code). The search, with nothing typed, ends with
 * a way into it and the two latest commands.
 */

import type { CommandInfo } from '../../core/commands';
import type { ShellModule } from '../../core/module';
import type { Highlight, QuickAccessGroup, QuickAccessItem } from '../../core/quickAccess';
import { ICommands, IKeybindings, IQuickAccess } from '../../core/serviceIds';
import { t } from './messages';

/** Commands run from the palette, latest first; localStorage is shared by the windows. */
const RECENT_KEY = 'vilaus.commandPalette.recent';
const RECENT_KEPT = 20;
/** The latest commands the search offers with nothing typed. */
const RECENT_IN_SEARCH = 2;

function loadRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...loadRecent().filter((other) => other !== id)].slice(0, RECENT_KEPT)));
  } catch {
    // Not remembered; the palette works the same.
  }
}

function labelOf(command: CommandInfo): string {
  return command.category ? `${command.category}: ${command.title}` : (command.title ?? command.id);
}

export const commandPaletteModule: ShellModule = {
  id: 'commandPalette',
  activate({ services, subscriptions }) {
    const commands = services.get(ICommands);
    const keybindings = services.get(IKeybindings);
    const quickAccess = services.get(IQuickAccess);

    const run = (id: string): Promise<unknown> => {
      remember(id);
      return commands.execute(id);
    };
    const item = (command: CommandInfo, highlights?: readonly Highlight[]): QuickAccessItem => ({
      label: labelOf(command),
      labelHighlights: highlights,
      keybinding: keybindings.labelFor(command.id),
      accept: () => run(command.id),
    });
    /** The palette's commands; the recently used ones apart, in the order they were used. */
    const listed = (): { recent: CommandInfo[]; others: CommandInfo[] } => {
      const available = commands.list().filter((command) => command.id !== 'commandPalette.show');
      const byId = new Map(available.map((command) => [command.id, command]));
      const recent = loadRecent().flatMap((id) => byId.get(id) ?? []);
      const others = available.filter((command) => !recent.includes(command)).sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
      return { recent, others };
    };

    subscriptions.add(
      quickAccess.registerProvider('>', {
        placeholder: () => t('placeholder'),
        provide: (query) => {
          const needle = query.toLowerCase();
          const matching = (list: readonly CommandInfo[]): QuickAccessItem[] =>
            list.flatMap((command) => {
              const at = needle ? labelOf(command).toLowerCase().indexOf(needle) : -1;
              if (needle && at < 0) {
                return [];
              }
              return [item(command, at >= 0 ? [[at, at + needle.length]] : undefined)];
            });
          const { recent, others } = listed();
          const recentItems = matching(recent);
          const otherItems = matching(others);
          if (recentItems.length === 0) {
            return [{ key: 'commands', result: { items: otherItems } }];
          }
          return [
            { key: 'recent', result: { label: t('recentlyUsed'), items: recentItems } },
            { key: 'commands', result: { label: t('otherCommands'), items: otherItems } },
          ];
        },
      }),
    );
    subscriptions.add(commands.register('commandPalette.show', () => quickAccess.show('>'), { title: t('showAllCommands'), palette: false }));
    subscriptions.add(keybindings.register({ key: 'ctrl+shift+p', command: 'commandPalette.show' }));
    subscriptions.add(keybindings.register({ key: 'f1', command: 'commandPalette.show' }));

    // In the search with nothing typed, after the folders.
    subscriptions.add(
      quickAccess.registerSearchContributor({
        id: 'commands',
        order: 50,
        provide: (query): QuickAccessGroup | undefined => {
          if (query) {
            return undefined;
          }
          const showAll: QuickAccessItem = {
            label: t('showAllCommands'),
            icon: 'chevron-right',
            keybinding: keybindings.labelFor('commandPalette.show'),
            accept: () => quickAccess.show('>'),
          };
          const latest = listed().recent.slice(0, RECENT_IN_SEARCH).map((command) => ({ ...item(command), icon: 'chevron-right' }));
          return { label: t('commands'), items: [showAll, ...latest] };
        },
      }),
    );
  },
};
