/** Color theme picker. The choice is saved as `vilaus.theme` in settings.json. */

import type { ShellModule } from '../../core/module';
import { CommandCategory, SettingsSection } from '../../core/messages';
import { ICommands, IDialogs, ISettings, IThemes } from '../../core/serviceIds';
import { ACCENT_COLOR_SETTING, ACCENT_SETTING, ACCENT_SOURCES, DEFAULT_CUSTOM_ACCENT } from '../../platform/accent';
import { DEFAULT_THEME_ID } from '../../platform/defaults';
import { t, themeLabel } from './messages';

export const themesModule: ShellModule = {
  id: 'themes',
  activate({ services, subscriptions }) {
    const commands = services.get(ICommands);
    const dialogs = services.get(IDialogs);
    const themes = services.get(IThemes);

    subscriptions.add(
      commands.register(
        'themes.select',
        async () => {
          const available = await themes.list();
          const current = themes.current.id;
          const picked = await dialogs.showQuickPick({
            title: t('colorTheme'),
            placeHolder: t('selectColorTheme'),
            canPickMany: false,
            items: available.map((theme) => ({
              label: themeLabel(theme.id, theme.label),
              description: theme.id === current ? t('current') : undefined,
            })),
          });
          const chosen = picked?.[0] !== undefined ? available[picked[0]] : undefined;
          if (chosen && chosen.id !== current) {
            await themes.select(chosen.id);
          }
        },
        { title: t('colorTheme'), category: CommandCategory.preferences },
      ),
    );

    // Main applies these (the fonts are in features/fonts).
    const settings = services.get(ISettings);
    subscriptions.add(
      settings.register([
        {
          key: ACCENT_SETTING,
          section: SettingsSection.workbench,
          order: 1,
          showDescription: true,
          schema: {
            type: 'string',
            default: 'provider',
            enum: [...ACCENT_SOURCES],
            enumItemLabels: [t('accentProvider'), t('accentCustom'), t('accentVscode')],
            description: t('accentSetting'),
          },
        },
        {
          key: ACCENT_COLOR_SETTING,
          section: SettingsSection.workbench,
          order: 2,
          schema: { type: 'string', format: 'color-hex', default: DEFAULT_CUSTOM_ACCENT, description: t('accentColorSetting') },
        },
      ]),
    );
    void themes.list().then((available) => {
      subscriptions.add(
        settings.register([
          {
            key: 'vilaus.theme',
            section: SettingsSection.workbench,
            order: 0,
            schema: {
              type: 'string',
              default: DEFAULT_THEME_ID,
              enum: available.map((theme) => theme.id),
              enumItemLabels: available.map((theme) => themeLabel(theme.id, theme.label)),
              description: t('themeSetting'),
            },
          },
        ]),
      );
    });
  },
};
