/**
 * Settings: the settings editor (a panel over the middle of the window: Ctrl+, or the gear
 * in the title bar),
 * settings.json in the text editor with a schema made of every declared setting
 * (completion, hovers, validation), and the extension's own settings declared from its
 * manifest.
 */

import { URI } from 'vscode-uri';
import { CommandCategory } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import {
  ICommands,
  IDialogs,
  IEditors,
  IExtensionHost,
  IKeybindings,
  ILayout,
  ISettings,
} from '../../core/serviceIds';
import { DisposableStore } from '../../platform/lifecycle';
import { IContentPane } from '../contentPane';
import { ITextEditors, TEXT_INPUT } from '../editor';
import { DefaultsSplitPane } from '../editor/defaultsSplitPane';
import { DefaultSettingsPane } from './defaultSettings';
import { extensionSettingDefinitions } from './extensionSettings';
import { t } from './messages';
import { SettingsDialog } from './settingsDialog';
import { defaultSettingsText, settingsJsonSchema } from './settingItems';

const DEFAULTS_INPUT = 'settings-defaults';

/**
 * The JSON language service matches a schema's `fileMatch` as a glob (with `**\/` put in
 * front) against the decoded document URI, so a full URI never matches: the file name with
 * its folder does. A folder name with glob characters falls back to the file name alone.
 */
export function settingsFileGlob(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  const name = parts.pop() ?? 'settings.json';
  const folder = parts.pop() ?? '';
  return /^[\w.-]+$/.test(folder) ? `${folder}/${name}` : name;
}
/** Identifies the schema of settings.json for the JSON language service. */
const SETTINGS_SCHEMA_URI = 'vilaus://schemas/settings.json';

/** Whether a document URI is the file at `filePath` (the case of the drive letter may differ). */
export function isFileUri(resource: string | undefined, filePath: string): boolean {
  return resource !== undefined && URI.parse(resource).fsPath.toLowerCase() === URI.file(filePath).fsPath.toLowerCase();
}

export const settingsModule: ShellModule = {
  id: 'settings',
  dependsOn: ['editor'],
  activate({ services, subscriptions, logger }) {
    const settings = services.get(ISettings);
    const contentPane = services.get(IContentPane);
    const editors = services.get(ITextEditors);
    const connection = services.get(IExtensionHost);
    const commands = services.get(ICommands);
    const dialogs = services.get(IDialogs);
    const settingsUri = URI.file(settings.filePath).toString();

    /** A file in a text tab; false when it could not be opened (it says so). */
    const openFile = async (uri: string): Promise<boolean> => {
      dialog.close();
      const shown = await connection.rpc?.call('documents.show', { uri, preserveFocus: false, preview: false });
      if (!shown) {
        await dialogs.showMessage({ severity: 'error', message: t('cannotOpenFile', URI.parse(uri).fsPath), modal: false, items: [] });
      }
      return shown === true;
    };
    /** settings.json in a text tab; with `key`, its entry selected (added with the default value if missing). */
    const openJson = async (key?: string): Promise<void> => {
      const rpc = connection.rpc;
      if (!rpc) {
        return;
      }
      if (key && !settings.isSet(key)) {
        const schema = settings.definition(key)?.schema;
        const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
        const empty = type === 'array' ? [] : type === 'object' ? {} : null;
        await settings.update(key, schema?.default ?? empty);
      }
      const shown = await rpc.call('documents.show', { uri: settingsUri, preserveFocus: false, preview: false });
      if (!shown) {
        await dialogs.showMessage({ severity: 'error', message: t('cannotOpenJson'), modal: false, items: [] });
        return;
      }
      if (key) {
        editors.revealText(settingsUri, JSON.stringify(key));
      }
    };
    const openJsonLogged = (key?: string): void => {
      openJson(key).catch((error: unknown) => logger.error('opening settings.json failed', error));
    };

    const openDefaults = (): void => {
      contentPane.open({ id: DEFAULTS_INPUT, typeId: DEFAULTS_INPUT, label: t('defaultSettingsTitle') }, { preview: false });
    };
    // What the panel opens goes in the content pane: the panel steps aside first.
    const dialog = new SettingsDialog(dialogs, {
      settings,
      openJson: (key) => {
        dialog.close();
        openJsonLogged(key);
      },
      openDefaults: () => {
        dialog.close();
        openDefaults();
      },
      logger,
    });
    subscriptions.add({ dispose: () => dialog.close() });
    subscriptions.add(
      services.get(IEditors).register({
        id: 'settings.defaults',
        accepts: (input) => input.typeId === DEFAULTS_INPUT,
        create: (container) => new DefaultSettingsPane(container, editors, settings, logger),
      }),
    );
    // settings.json beside the defaults, as VS Code can show it: over the plain text editor, which it embeds.
    subscriptions.add(
      services.get(IEditors).register({
        id: 'settings.jsonWithDefaults',
        priority: 20,
        accepts: (input) => input.typeId === TEXT_INPUT && isFileUri(input.resource, settings.filePath),
        create: (container, input, host) =>
          new DefaultsSplitPane(
            container,
            input,
            host,
            editors,
            {
              defaultsUri: 'vilaus-settings:/settings.defaults.json',
              defaultsTitle: t('defaultSettingsSide'),
              defaultsText: () =>
                defaultSettingsText(settings.definitions, { header: t('defaultSettingsSideHeader'), deprecated: t('deprecated') }),
              onDidChangeDefaults: settings.onDidChangeDefinitions,
              stateKey: 'vilaus.settingsJson.split',
            },
            logger,
          ),
      }),
    );
    /** `query` fills the search box (the extension's "open configuration" searches for its settings). */
    const openUi = (query?: unknown): void => dialog.show(typeof query === 'string' ? query : undefined);

    // settings.json gets the schema of everything declared, kept current as modules declare more.
    const fileMatch = [settingsFileGlob(settings.filePath)];
    const updateSchema = (): void => {
      editors.setJsonSchemas('settings', [{ uri: SETTINGS_SCHEMA_URI, fileMatch, schema: settingsJsonSchema(settings.definitions) }]);
    };
    updateSchema();
    subscriptions.add(settings.onDidChangeDefinitions(updateSchema));

    // The extension's settings, from its manifest; again for each extension host.
    const extensionSettings = subscriptions.add(new DisposableStore());
    subscriptions.add(
      connection.onDidConnect((rpc) => {
        rpc.handle('workbench.openSettings', ({ query }) => openUi(query));
        rpc.call('extension.contributions', undefined).then(
          (contributions) => {
            if (connection.rpc === rpc) {
              extensionSettings.clear();
              extensionSettings.add(settings.register(extensionSettingDefinitions(contributions)));
            }
          },
          (error: unknown) => logger.error('reading the extension settings failed', error),
        );
      }),
    );

    const gear = document.createElement('button');
    gear.className = 'icon-button titlebar-button icon-gear';
    services.get(IKeybindings).bindTooltip(gear, t('settingsTooltip'), 'settings.open');
    gear.setAttribute('aria-label', t('openSettings'));
    gear.addEventListener('click', () => openUi());
    // Between the app's name and the API provider.
    subscriptions.add(services.get(ILayout).addTitleBarItem('left', gear, 11));

    subscriptions.add(
      commands.register('settings.open', openUi, { title: t('openSettings'), category: CommandCategory.preferences }),
    );
    subscriptions.add(
      commands.register('settings.openJson', () => openJsonLogged(), {
        title: t('openSettingsJson'),
        category: CommandCategory.preferences,
      }),
    );
    subscriptions.add(
      commands.register('settings.openDefaults', openDefaults, {
        title: t('openDefaultSettings'),
        category: CommandCategory.preferences,
      }),
    );
    // For modules whose block in the panel opens something else (the API providers' editor).
    subscriptions.add(commands.register('settings.close', () => dialog.close()));
    // For modules that open the panel at their section (the keyboard shortcuts).
    subscriptions.add(
      commands.register('settings.openSection', (section) => dialog.show(undefined, typeof section === 'string' ? section : undefined)),
    );
    // For modules that open a file of the settings folder (keybindings.json): the panel steps aside.
    subscriptions.add(commands.register('settings.openFile', (uri) => typeof uri === 'string' && openFile(uri)));
    subscriptions.add(services.get(IKeybindings).register({ key: 'ctrl+,', command: 'settings.open' }));
  },
};
