/**
 * API providers (M4): which service a window's new conversations use. The title bar shows
 * the window's provider in its accent color and switches it; the providers editor (a
 * content pane tab) adds and edits providers. A key never comes back to the page once it
 * is typed: main keeps it encrypted and gives it only to the extension host.
 */

import type { ShellModule } from '../../core/module';
import { ICommands, IDialogs, IEditors, ILayout, INative, ISettings } from '../../core/serviceIds';
import { DisposableStore } from '../../platform/lifecycle';
import { DEFAULT_PROVIDER_SETTING, SUBSCRIPTION_ID, type ProviderSummary } from '../../platform/providers';
import type { QuickPickItemDto } from '../../platform/protocol';
import { IContentPane } from '../contentPane';
import { IConversations } from '../conversations';
import { t } from './messages';
import { PROVIDER_PRESETS } from './presets';
import { addFromPreset, providerLabel, ProvidersEditorPane, ProvidersModel, typeLabel } from './providersEditor';

const EDITOR_INPUT = 'providers';

export const providersModule: ShellModule = {
  id: 'providers',
  dependsOn: ['contentPane', 'conversations'],
  async activate({ services, subscriptions, logger }) {
    const native = services.get(INative);
    const commands = services.get(ICommands);
    const dialogs = services.get(IDialogs);
    const settings = services.get(ISettings);
    const contentPane = services.get(IContentPane);
    const init = await native.call('app.getInitData', undefined);
    const model = new ProvidersModel(init.providers);
    subscriptions.add(native.on('providersChanged', (state) => model.update(state)));

    // The title bar: [■ DeepSeek ▾]. A provider's color also draws a line under the title bar.
    const button = document.createElement('button');
    button.className = 'titlebar-button titlebar-provider';
    const swatch = document.createElement('span');
    swatch.className = 'provider-swatch';
    const label = document.createElement('span');
    label.className = 'titlebar-provider-label';
    const chevron = document.createElement('span');
    chevron.className = 'titlebar-chevron';
    button.append(swatch, label, chevron);
    button.addEventListener('click', () => void commands.execute('providers.switch'));
    subscriptions.add(services.get(ILayout).addTitleBarItem('left', button, 12));
    const show = (): void => {
      const active = model.active;
      const name = active ? providerLabel(active) : t('subscription');
      label.textContent = name;
      button.title = t('buttonTitle', name);
      swatch.hidden = !active?.color;
      swatch.style.backgroundColor = active?.color ?? '';
      document.body.classList.toggle('provider-accent', Boolean(active?.color));
      document.documentElement.style.setProperty('--vilaus-provider-color', active?.color ?? 'transparent');
    };
    show();
    subscriptions.add(model.onDidChange(show));

    const openEditor = (select?: string): void => {
      const tab = contentPane.open({ id: EDITOR_INPUT, typeId: EDITOR_INPUT, label: t('editorTitle') }, { preview: false });
      if (select && tab?.pane instanceof ProvidersEditorPane) {
        tab.pane.select(select);
      }
    };

    const add = async (): Promise<ProviderSummary | undefined> => {
      const chosen = await dialogs.showQuickPick({
        items: PROVIDER_PRESETS.map((preset) => ({ label: preset.name(), description: preset.config.baseUrl ?? '' })),
        placeHolder: t('startFrom'),
        canPickMany: false,
      });
      const preset = chosen?.[0] === undefined ? undefined : PROVIDER_PRESETS[chosen[0]];
      return preset ? addFromPreset(preset.id, model, native) : undefined;
    };

    const switchTo = async (id: string): Promise<void> => {
      if (id === model.state.current) {
        return;
      }
      await native.call('providers.select', { id });
      // The open conversations keep the processes they started with.
      if ((services.tryGet(IConversations)?.count ?? 0) > 0) {
        const provider = model.state.providers.find((candidate) => candidate.id === id);
        const choice = await dialogs.showMessage({
          severity: 'info',
          modal: false,
          message: t('switched', provider ? providerLabel(provider) : id),
          items: [t('reload')],
        });
        if (choice === 0) {
          await native.call('window.reload', undefined);
        }
      }
    };

    subscriptions.add(
      services.get(IEditors).register({
        id: 'providers.editor',
        accepts: (input) => input.typeId === EDITOR_INPUT,
        create: (container) => new ProvidersEditorPane(container, { model, native, dialogs, logger, add }),
      }),
    );

    subscriptions.add(
      commands.register(
        'providers.switch',
        async () => {
          const { providers, current } = model.state;
          const describe = (provider: ProviderSummary): string =>
            [
              provider.id === current ? t('current') : '',
              provider.type === 'subscription' ? '' : typeLabel(provider.type),
              (provider.type === 'compatible' || provider.type === 'anthropic-api') && !provider.hasKey ? t('noKey') : '',
            ]
              .filter(Boolean)
              .join(' · ');
          const actions = [
            { label: t('manage'), run: () => openEditor() },
            {
              label: t('addProvider'),
              run: async () => {
                const added = await add();
                if (added) {
                  openEditor(added.id);
                }
              },
            },
          ];
          const items: QuickPickItemDto[] = [
            ...providers.map((provider) => ({ label: providerLabel(provider), description: describe(provider) })),
            { label: '', separator: true },
            ...actions.map((action) => ({ label: action.label })),
          ];
          const chosen = (await dialogs.showQuickPick({ items, placeHolder: t('pickProvider'), canPickMany: false }))?.[0];
          if (chosen === undefined) {
            return;
          }
          const provider = providers[chosen];
          if (provider) {
            await switchTo(provider.id);
          } else {
            await actions[chosen - providers.length - 1]?.run();
          }
        },
        { title: t('switchProvider'), category: t('category') },
      ),
    );
    subscriptions.add(
      commands.register('providers.manage', () => openEditor(), { title: t('manage'), category: t('category') }),
    );
    subscriptions.add(
      commands.register(
        'providers.add',
        // Resolves to the new provider's id (the first-run page switches to it once it has a key).
        async (): Promise<string | undefined> => {
          const added = await add();
          if (added) {
            openEditor(added.id);
          }
          return added?.id;
        },
        { title: t('addProvider'), category: t('category') },
      ),
    );

    // In the settings panel: a way to the providers' editor, and the default provider below it.
    const settingsSection = t('settingsSection');
    subscriptions.add(
      settings.registerWidget({
        id: 'providers.entry',
        section: settingsSection,
        keywords: t('settingsKeywords'),
        create: (container) => {
          container.classList.add('providers-entry');
          const current = document.createElement('span');
          current.className = 'providers-entry-current';
          const manage = document.createElement('button');
          manage.className = 'button secondary';
          manage.textContent = t('manageEllipsis');
          manage.addEventListener('click', () => {
            void commands.execute('settings.close');
            openEditor();
          });
          container.append(current, manage);
          const render = (): void => {
            const active = model.active;
            current.textContent = t('settingsCurrent', active ? providerLabel(active) : t('subscription'));
          };
          render();
          return model.onDidChange(render);
        },
      }),
    );

    // The default provider: a dropdown of the providers there are, kept current.
    const setting = subscriptions.add(new DisposableStore());
    const registerSetting = (): void => {
      setting.clear();
      const { providers } = model.state;
      setting.add(
        settings.register([
          {
            key: DEFAULT_PROVIDER_SETTING,
            section: settingsSection,
            order: 1,
            showDescription: true,
            schema: {
              type: 'string',
              default: SUBSCRIPTION_ID,
              enum: providers.map((provider) => provider.id),
              enumItemLabels: providers.map((provider) => providerLabel(provider)),
              description: t('defaultSetting'),
            },
          },
        ]),
      );
    };
    registerSetting();
    subscriptions.add(model.onDidChange(registerSetting));
  },
};
