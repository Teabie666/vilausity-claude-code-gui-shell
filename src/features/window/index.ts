/**
 * Window-level features: title, closing and quitting, zoom, developer tools; in the
 * administrator instance, a badge in the title bar.
 */

import type { ShellModule } from '../../core/module';
import { CommandCategory } from '../../core/messages';
import { ICommands, IDialogs, IKeybindings, ILayout, INative, IWorkspace } from '../../core/serviceIds';
import { t } from './messages';

export const windowModule: ShellModule = {
  id: 'window',
  async activate({ services, subscriptions }) {
    const layout = services.get(ILayout);
    const commands = services.get(ICommands);
    const keybindings = services.get(IKeybindings);
    const native = services.get(INative);
    const workspace = services.get(IWorkspace);

    // The folder button next to it comes from the workspace module.
    const brand = document.createElement('div');
    brand.className = 'titlebar-brand';
    const app = document.createElement('span');
    app.className = 'titlebar-app';
    app.textContent = 'Vilausity';
    brand.append(app);
    if ((await native.call('app.getInitData', undefined)).elevated) {
      const badge = document.createElement('span');
      badge.className = 'titlebar-admin';
      badge.textContent = t('administrator');
      badge.title = t('administratorTooltip');
      brand.append(badge);
    }
    subscriptions.add(layout.addTitleBarItem('left', brand, 10));
    document.title = `${workspace.name} - Vilausity`;

    const zoom = (delta: number) => () => native.call('window.zoom', { delta });
    // One notification of each severity, to check their look. The ones with buttons stay
    // until answered, so they can be inspected in the developer tools.
    const showSampleNotifications = (): void => {
      const dialogs = services.get(IDialogs);
      const samples = [
        { severity: 'info', message: t('sampleInfo'), items: [t('sampleAction'), t('sampleLater')] },
        { severity: 'warning', message: t('sampleWarning'), items: [] },
        { severity: 'error', message: t('sampleError'), items: [t('sampleAction')] },
      ] as const;
      for (const sample of samples) {
        void dialogs.showMessage({ ...sample, modal: false });
      }
    };
    [
      commands.register('window.close', () => native.call('window.close', undefined), {
        title: t('closeWindow'),
        category: CommandCategory.view,
      }),
      commands.register('app.quit', () => native.call('app.quit', undefined), {
        title: t('quit'),
        category: CommandCategory.file,
      }),
      commands.register('window.zoomIn', zoom(1), { title: t('zoomIn'), category: CommandCategory.view }),
      commands.register('window.zoomOut', zoom(-1), { title: t('zoomOut'), category: CommandCategory.view }),
      commands.register('window.zoomReset', zoom(0), { title: t('resetZoom'), category: CommandCategory.view }),
      commands.register('window.toggleDevTools', () => native.call('window.toggleDevTools', undefined), {
        title: t('toggleDevTools'),
        category: CommandCategory.developer,
      }),
      commands.register('window.showSampleNotifications', showSampleNotifications, {
        title: t('showSampleNotifications'),
        category: CommandCategory.developer,
      }),
      keybindings.register({ key: 'ctrl+shift+w', command: 'window.close' }),
      keybindings.register({ key: 'ctrl+=', command: 'window.zoomIn' }),
      keybindings.register({ key: 'ctrl+numpad_add', command: 'window.zoomIn' }),
      keybindings.register({ key: 'ctrl+-', command: 'window.zoomOut' }),
      keybindings.register({ key: 'ctrl+numpad_subtract', command: 'window.zoomOut' }),
      keybindings.register({ key: 'ctrl+0', command: 'window.zoomReset' }),
    ].forEach((disposable) => subscriptions.add(disposable));
  },
};
