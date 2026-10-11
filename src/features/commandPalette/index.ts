/**
 * Command palette: quick access after `>` (Ctrl+Shift+P, F1, the button at the end of the
 * title bar's search box): every titled, enabled shell command.
 */

import type { ShellModule } from '../../core/module';
import type { Highlight, QuickAccessItem } from '../../core/quickAccess';
import { ICommands, IKeybindings, IQuickAccess } from '../../core/serviceIds';
import { t } from './messages';

export const commandPaletteModule: ShellModule = {
  id: 'commandPalette',
  activate({ services, subscriptions }) {
    const commands = services.get(ICommands);
    const keybindings = services.get(IKeybindings);
    const quickAccess = services.get(IQuickAccess);

    subscriptions.add(
      quickAccess.registerProvider('>', {
        placeholder: () => t('placeholder'),
        provide: (query) => {
          const needle = query.toLowerCase();
          const items = commands
            .list()
            .filter((command) => command.id !== 'commandPalette.show')
            .map((command) => ({
              id: command.id,
              label: command.category ? `${command.category}: ${command.title}` : (command.title ?? command.id),
            }))
            .sort((a, b) => a.label.localeCompare(b.label))
            .flatMap(({ id, label }): QuickAccessItem[] => {
              const at = needle ? label.toLowerCase().indexOf(needle) : -1;
              if (needle && at < 0) {
                return [];
              }
              const highlight: Highlight = [at, at + needle.length];
              return [
                {
                  label,
                  labelHighlights: at >= 0 ? [highlight] : undefined,
                  keybinding: keybindings.labelFor(id),
                  accept: () => commands.execute(id),
                },
              ];
            });
          return [{ key: 'commands', result: { items } }];
        },
      }),
    );
    subscriptions.add(commands.register('commandPalette.show', () => quickAccess.show('>')));
    subscriptions.add(keybindings.register({ key: 'ctrl+shift+p', command: 'commandPalette.show' }));
    subscriptions.add(keybindings.register({ key: 'f1', command: 'commandPalette.show' }));
  },
};
