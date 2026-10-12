/**
 * Keyboard shortcuts: a section of the settings with every keybinding (features/keybindings
 * /table.ts), the user's keybindings.json (main reads, watches and writes it; the core
 * keybinding service lays it over the defaults), and that file's schema in the editor.
 */

import { URI } from 'vscode-uri';
import type { CommandInfo } from '../../core/commands';
import { CommandCategory } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { ICommands, IDialogs, IEditors, IKeybindings, ILayout, INative, ISettings } from '../../core/serviceIds';
import { ITextEditors, TEXT_INPUT } from '../editor';
import { DefaultsSplitPane } from '../editor/defaultsSplitPane';
import { isFileUri, settingsFileGlob } from '../settings';
import { defaultKeybindingsText } from './defaultsText';
import { t } from './messages';
import { createShortcutsTable } from './table';

const SCHEMA_URI = 'vilaus://schemas/keybindings.json';

/** keybindings.json: completion of the command ids (and `-` removals); any string is allowed. */
export function keybindingsJsonSchema(commands: readonly CommandInfo[]): Record<string, unknown> {
  const sorted = [...commands].sort((a, b) => a.id.localeCompare(b.id));
  const describe = (info: CommandInfo): string => (info.title ? (info.category ? `${info.category}: ${info.title}` : info.title) : '');
  return {
    type: 'array',
    items: {
      type: 'object',
      required: ['key', 'command'],
      properties: {
        key: { type: 'string', description: t('schemaKey') },
        command: {
          anyOf: [
            { type: 'string', enum: sorted.map((info) => info.id), enumDescriptions: sorted.map(describe) },
            {
              type: 'string',
              enum: sorted.map((info) => `-${info.id}`),
              enumDescriptions: sorted.map((info) => t('schemaRemoval', describe(info) || info.id)),
            },
            { type: 'string' },
          ],
          description: t('schemaCommand'),
        },
        when: { type: 'string', description: t('schemaWhen') },
        args: { description: t('schemaArgs') },
      },
    },
  };
}

export const keybindingsModule: ShellModule = {
  id: 'keybindings',
  dependsOn: ['settings', 'editor'],
  activate({ services, subscriptions, logger }) {
    const keybindings = services.get(IKeybindings);
    const commands = services.get(ICommands);
    const dialogs = services.get(IDialogs);
    const native = services.get(INative);
    const editors = services.get(ITextEditors);
    const fileUri = URI.file(keybindings.filePath).toString();
    const openJson = (): void => void commands.execute('settings.openFile', fileUri);

    subscriptions.add(
      services.get(ISettings).registerWidget({
        id: 'keybindings.table',
        section: t('section'),
        keywords: t('keywords'),
        create: (container) =>
          createShortcutsTable(container, {
            keybindings,
            commands,
            dialogs,
            edit: ({ remove, add }) => native.call('keybindings.edit', { remove, add }),
            openJson,
            logger,
          }),
      }),
    );

    subscriptions.add(
      commands.register('keybindings.open', () => commands.execute('settings.openSection', t('section')), {
        title: t('openKeyboardShortcuts'),
        category: CommandCategory.preferences,
      }),
    );
    subscriptions.add(
      commands.register('keybindings.openJson', openJson, {
        title: t('openKeyboardShortcutsJson'),
        category: CommandCategory.preferences,
      }),
    );

    // The schema follows the commands as modules register them.
    const fileMatch = [settingsFileGlob(keybindings.filePath)];
    let scheduled = false;
    const updateSchema = (): void => {
      if (scheduled) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        editors.setJsonSchemas('keybindings', [{ uri: SCHEMA_URI, fileMatch, schema: keybindingsJsonSchema(commands.all) }]);
      });
    };
    updateSchema();
    subscriptions.add(commands.onDidChange(updateSchema));

    // keybindings.json beside the default keybindings, like settings.json beside the default settings.
    const describe = (id: string): string => {
      const info = commands.all.find((candidate) => candidate.id === id);
      return info?.title ? (info.category ? `${info.category}: ${info.title}` : info.title) : '';
    };
    subscriptions.add(
      services.get(IEditors).register({
        id: 'keybindings.jsonWithDefaults',
        priority: 20,
        accepts: (input) => input.typeId === TEXT_INPUT && isFileUri(input.resource, keybindings.filePath),
        create: (container, input, host) =>
          new DefaultsSplitPane(
            container,
            input,
            host,
            editors,
            {
              defaultsUri: 'vilaus-settings:/keybindings.defaults.json',
              defaultsTitle: t('defaultKeybindingsSide'),
              defaultsText: () => defaultKeybindingsText(keybindings.defaultRules, describe, t('defaultKeybindingsHeader')),
              onDidChangeDefaults: keybindings.onDidChange,
              stateKey: 'vilaus.keybindingsJson.split',
              widen: (width) => services.get(ILayout).widenContentPane(width),
            },
            logger,
          ),
      }),
    );
  },
};
