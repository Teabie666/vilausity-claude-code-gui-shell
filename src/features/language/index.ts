/**
 * Display language: the picker command, and the prompt to restart once the settings ask
 * for another language than this run shows. The language itself is decided by main at
 * startup (platform/nls.ts); changing it takes a restart, as in VS Code.
 */

import { SettingsSection } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { ICommands, IDialogs, INative, ISettings, IWebviewFrames } from '../../core/serviceIds';
import { TRANSLATE_EXTENSION_UI_SETTING } from '../../platform/extensionStrings';
import { LANGUAGE_NAMES, LANGUAGE_SETTING, type UiLanguageSetting } from '../../platform/nls';
import { t } from './messages';

export const languageModule: ShellModule = {
  id: 'language',
  activate({ services, subscriptions, logger }) {
    const commands = services.get(ICommands);
    const dialogs = services.get(IDialogs);
    const native = services.get(INative);

    subscriptions.add(
      commands.register(
        'language.configure',
        async () => {
          const { setting } = await native.call('app.getLanguage', undefined);
          const options: readonly { readonly setting: UiLanguageSetting; readonly label: string }[] = [
            { setting: 'auto', label: t('followSystem') },
            { setting: 'zh-cn', label: LANGUAGE_NAMES['zh-cn'] },
            { setting: 'en', label: LANGUAGE_NAMES.en },
          ];
          const picked = await dialogs.showQuickPick({
            placeHolder: t('selectDisplayLanguage'),
            canPickMany: false,
            items: options.map((option) => ({
              label: option.label,
              description: option.setting === setting ? t('currentSetting', option.setting) : option.setting,
            })),
          });
          const chosen = picked?.[0] !== undefined ? options[picked[0]] : undefined;
          if (chosen && chosen.setting !== setting) {
            await native.call('app.setLanguage', { setting: chosen.setting });
          }
        },
        { title: t('configureDisplayLanguage') },
      ),
    );

    subscriptions.add(
      services.get(ISettings).register([
        {
          key: LANGUAGE_SETTING,
          section: SettingsSection.workbench,
          order: 3,
          showDescription: true,
          schema: {
            type: 'string',
            default: 'auto',
            enum: ['auto', 'zh-cn', 'en'],
            enumItemLabels: [t('followSystem'), LANGUAGE_NAMES['zh-cn'], LANGUAGE_NAMES.en],
            description: t('languageSetting'),
          },
        },
        {
          key: TRANSLATE_EXTENSION_UI_SETTING,
          section: SettingsSection.workbench,
          order: 4,
          showDescription: true,
          schema: { type: 'boolean', default: true, description: t('translateExtensionUiSetting') },
        },
      ]),
    );

    // Main decides (language, setting) and renders new webviews accordingly; open ones follow here.
    subscriptions.add(
      native.on('extensionTranslationsChanged', ({ translations }) => services.get(IWebviewFrames).setTranslations(translations)),
    );

    // Comes from main whether the language was picked above or edited in settings.json.
    subscriptions.add(
      native.on('languageChanged', ({ language }) => {
        dialogs
          .showMessage({
            severity: 'info',
            message: t('restartToApply', LANGUAGE_NAMES[language]),
            modal: false,
            items: [t('restart')],
          })
          .then((answer) => (answer === 0 ? native.call('app.relaunch', undefined) : undefined))
          .catch((error: unknown) => logger.error('restarting for the display language failed', error));
      }),
    );
  },
};
