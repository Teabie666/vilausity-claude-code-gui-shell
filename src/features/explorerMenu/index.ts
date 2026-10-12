/**
 * The settings switch for File Explorer's "Open with Vilausity" entries. Main writes them to
 * the registry (host/main/explorerMenu.ts); the registry is what is true, not settings.json,
 * since the installer can add them too. Laid out like a checkbox setting with its description.
 */

import { SettingsSection } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { IDialogs, INative, ISettings } from '../../core/serviceIds';
import { t } from './messages';

export const explorerMenuModule: ShellModule = {
  id: 'explorerMenu',
  activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const dialogs = services.get(IDialogs);

    subscriptions.add(
      services.get(ISettings).registerWidget({
        id: 'explorerMenu.switch',
        section: SettingsSection.workbench,
        keywords: `${t('category')} ${t('name')} ${t('description')} ${t('keywords')}`,
        create: (container) => {
          // Not a `.setting-item`: the search takes those for declared settings.
          container.classList.add('settings-widget-row');
          const title = document.createElement('div');
          title.className = 'setting-title';
          const category = document.createElement('span');
          category.className = 'setting-category';
          category.textContent = `${t('category')}: `;
          const name = document.createElement('span');
          name.className = 'setting-name';
          name.textContent = t('name');
          title.append(category, name);
          const row = document.createElement('label');
          row.className = 'setting-checkbox-row';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.className = 'setting-checkbox';
          // Until main has looked in the registry.
          box.disabled = true;
          const description = document.createElement('span');
          description.className = 'setting-description';
          description.textContent = t('description');
          row.append(box, description);
          container.append(title, row);

          let disposed = false;
          const show = (registered: boolean): void => {
            if (!disposed) {
              box.checked = registered;
              box.disabled = false;
            }
          };
          native.call('explorerMenu.get', undefined).then(show, (error: unknown) => logger.error('reading the File Explorer menu failed', error));
          box.addEventListener('change', () => {
            box.disabled = true;
            native.call('explorerMenu.set', { enabled: box.checked }).then(show, (error: unknown) => {
              logger.error('changing the File Explorer menu failed', error);
              void dialogs.showMessage({ severity: 'error', message: t('failed'), modal: false, items: [] });
              void native.call('explorerMenu.get', undefined).then(show);
            });
          });
          return {
            dispose: () => {
              disposed = true;
            },
          };
        },
      }),
    );
  },
};
