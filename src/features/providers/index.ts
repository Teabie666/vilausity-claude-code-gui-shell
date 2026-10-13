/**
 * API providers (M4): which service a window's new conversations use. The title bar shows
 * the window's provider with its accent color and switches it; the providers editor (a
 * content pane tab) adds and edits providers. A key never comes back to the page once it
 * is typed: main keeps it encrypted and gives it only to the extension host. Main also lays
 * the provider's accent over the window's theme (platform/accent.ts, the `vilaus.accent`
 * setting in features/themes): the line along the top of the window, and the highlights.
 */

import type { ShellModule } from '../../core/module';
import { ICommands, IDialogs, IEditors, IExtensionHost, ILayout, INative, ISettings, IWebviewFrames } from '../../core/serviceIds';
import { DisposableStore } from '../../platform/lifecycle';
import { DEFAULT_PROVIDER_SETTING, SUBSCRIPTION_ID, type ProviderSummary } from '../../platform/providers';
import type { QuickPickItemDto } from '../../platform/protocol';
import { CURRENT_PROVIDER_ONLY_SETTING } from '../../platform/usage';
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

    // The title bar: [DeepSeek ▾].
    const button = document.createElement('button');
    button.className = 'titlebar-button titlebar-provider';
    const label = document.createElement('span');
    label.className = 'titlebar-provider-label';
    const chevron = document.createElement('span');
    chevron.className = 'titlebar-chevron';
    button.append(label, chevron);
    button.addEventListener('click', () => void commands.execute('providers.switch'));
    subscriptions.add(services.get(ILayout).addTitleBarItem('left', button, 12));
    const show = (): void => {
      const active = model.active;
      const name = active ? providerLabel(active) : t('subscription');
      label.textContent = name;
      button.title = t('buttonTitle', name);
    };
    show();
    subscriptions.add(model.onDidChange(show));

    const openEditor = (select?: string): ProvidersEditorPane | undefined => {
      const tab = contentPane.open({ id: EDITOR_INPUT, typeId: EDITOR_INPUT, label: t('editorTitle') }, { preview: false });
      const pane = tab?.pane instanceof ProvidersEditorPane ? tab.pane : undefined;
      if (select) {
        pane?.select(select);
      }
      return pane;
    };
    // The session list's usage block links to the prices of the window's provider.
    const frames = services.get(IWebviewFrames);
    subscriptions.add(frames.onDidRequestEditPrices(() => openEditor(model.state.current)?.revealPrices()));
    // Its toggle keeps only the sessions of the window's provider.
    subscriptions.add(
      frames.onDidToggleProviderFilter(() => {
        void settings.update(CURRENT_PROVIDER_ONLY_SETTING, settings.get(CURRENT_PROVIDER_ONLY_SETTING, false) ? undefined : true);
      }),
    );
    // A conversation that ran under another provider: the window switches to it and the
    // conversation opens again, with a Claude process of that provider (the old one ends first).
    subscriptions.add(
      frames.onDidRequestProviderSwitch(({ providerId, sessionId }) => {
        const reopen = async (): Promise<void> => {
          await services.get(IExtensionHost).rpc?.call('sessions.close', { sessionId });
          await native.call('providers.select', { id: providerId });
          if (!(await native.call('sessions.reopen', { sessionId }))) {
            await dialogs.showMessage({ severity: 'error', modal: false, message: t('reopenFailed'), items: [] });
          }
        };
        reopen().catch((error: unknown) => logger.error(`switching session ${sessionId} to ${providerId} failed`, error));
      }),
    );

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
          const actions: { label: string; run: () => void | Promise<void> }[] = [
            {
              label: t('manage'),
              run: () => {
                openEditor();
              },
            },
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
      commands.register(
        'providers.manage',
        () => {
          openEditor();
        },
        { title: t('manage'), category: t('category') },
      ),
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
    subscriptions.add(
      settings.register([
        {
          key: CURRENT_PROVIDER_ONLY_SETTING,
          section: settingsSection,
          order: 2,
          schema: { type: 'boolean', default: false, description: t('currentProviderOnlySetting') },
        },
      ]),
    );
  },
};
