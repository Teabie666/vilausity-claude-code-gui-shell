/**
 * Conversations: the extension's chat panels as tabs above the conversation (shown once
 * there are several), with commands and keybindings to create, switch and close them.
 * Offers IConversations to other modules.
 */

import type { ShellModule } from '../../core/module';
import { SettingsSection } from '../../core/messages';
import {
  ICommands,
  IContextKeys,
  IWorkspace,
  IExtensionHost,
  IKeybindings,
  ILayout,
  IPanels,
  ISettings,
  IThemes,
  IWebviewFrames,
} from '../../core/serviceIds';
import { createServiceId } from '../../core/services';
import { ConversationTabs } from './conversationTabs';
import { FindWidget } from './findWidget';
import { t } from './messages';

export const IConversations = createServiceId<ConversationTabs>('conversations');

/** Extension commands (anthropic.claude-code 2.1.282 package.json). */
const EXT_OPEN_CHAT = 'claude-vscode.editor.open';
const EXT_REOPEN_CLOSED = 'claude-vscode.reopenClosedSession';
const EXT_FOCUS_INPUT = 'claude-vscode.focus';
const EXT_SHOW_LOGS = 'claude-vscode.showLogs';
const EXT_LOGOUT = 'claude-vscode.logout';

/** Off: the tab row shows only with two or more conversations. */
const ALWAYS_SHOW_TABS = 'vilaus.conversations.alwaysShowTabs';

export const conversationsModule: ShellModule = {
  id: 'conversations',
  activate({ services, subscriptions }) {
    const layout = services.get(ILayout);
    const commands = services.get(ICommands);
    const keybindings = services.get(IKeybindings);
    const contextKeys = services.get(IContextKeys);
    const connection = services.get(IExtensionHost);
    const themes = services.get(IThemes);

    const emptyState = createEmptyState(() => void commands.execute('conversations.new'));
    layout.main.appendChild(emptyState);

    const frames = services.get(IWebviewFrames);
    const tabs = new ConversationTabs(layout.tabs, layout.main, frames, connection, themes);
    subscriptions.add(services.register(IConversations, tabs));
    const find = subscriptions.add(new FindWidget(layout.main, frames, () => tabs.active?.webviewId));
    subscriptions.add(tabs.onDidChangeActive(() => find.retarget()));

    const settings = services.get(ISettings);
    subscriptions.add(
      settings.register([
        {
          key: ALWAYS_SHOW_TABS,
          section: SettingsSection.workbench,
          order: 10,
          schema: { type: 'boolean', default: false, description: t('alwaysShowTabsSetting') },
        },
      ]),
    );

    const updateContext = (): void => {
      contextKeys.set('conversations.count', tabs.count);
      contextKeys.set('conversations.hasActive', tabs.active !== undefined);
      contextKeys.set('conversations.multiple', tabs.count > 1);
      emptyState.hidden = tabs.count > 0 || !connection.isConnected;
      layout.tabs.hidden = tabs.count < (settings.get(ALWAYS_SHOW_TABS, false) ? 1 : 2);
    };
    subscriptions.add(tabs.onDidChangeCount(updateContext));
    subscriptions.add(tabs.onDidChangeActive(updateContext));
    subscriptions.add(settings.onDidChange((keys) => keys.includes(ALWAYS_SHOW_TABS) && updateContext()));
    const workspaceName = services.get(IWorkspace).name;
    subscriptions.add(
      tabs.onDidChangeActive((panel) => {
        document.title = panel ? `${panel.title} - ${workspaceName} - Vilausity` : `${workspaceName} - Vilausity`;
      }),
    );
    subscriptions.add(themes.onDidChange(() => tabs.refreshIcons()));

    subscriptions.add(
      services.get(IPanels).registerHost('main', {
        create: (params) => tabs.create(params),
        update: (params) => tabs.update(params),
        reveal: (panelId, preserveFocus) => tabs.reveal(panelId, preserveFocus),
        remove: (panelId) => tabs.remove(panelId),
      }),
    );
    subscriptions.add(connection.onDidConnect(() => updateContext()));
    subscriptions.add(
      connection.onDidDisconnect(() => {
        tabs.clear();
        updateContext();
      }),
    );

    const ext = (id: string) => () => connection.executeCommand(id);
    const register = [
      commands.register('conversations.new', ext(EXT_OPEN_CHAT), { title: t('newConversation'), category: 'Claude' }),
      commands.register('conversations.close', () => tabs.requestClose(), {
        title: t('closeConversation'),
        category: 'Claude',
        when: 'conversations.hasActive',
      }),
      commands.register('conversations.next', () => tabs.cycle(1), { when: 'conversations.multiple' }),
      commands.register('conversations.previous', () => tabs.cycle(-1), { when: 'conversations.multiple' }),
      commands.register('conversations.goTo', (index) => tabs.activateIndex(Number(index))),
      commands.register('conversations.reopenClosed', ext(EXT_REOPEN_CLOSED), {
        title: t('reopenClosedConversation'),
        category: 'Claude',
      }),
      commands.register('conversations.focusInput', ext(EXT_FOCUS_INPUT), { title: t('focusInput'), category: 'Claude' }),
      commands.register('conversations.find', () => find.show(), {
        title: t('findInConversation'),
        category: 'Claude',
        when: 'conversations.hasActive',
      }),
      commands.register('claude.showLogs', ext(EXT_SHOW_LOGS), { title: t('showLogs'), category: 'Claude' }),
      commands.register('claude.logout', ext(EXT_LOGOUT), { title: t('signOut'), category: 'Claude' }),
      keybindings.register({ key: 'ctrl+n', command: 'conversations.new' }),
      keybindings.register({ key: 'ctrl+w', command: 'conversations.close' }),
      keybindings.register({ key: 'ctrl+tab', command: 'conversations.next' }),
      keybindings.register({ key: 'ctrl+pagedown', command: 'conversations.next' }),
      keybindings.register({ key: 'ctrl+shift+tab', command: 'conversations.previous' }),
      keybindings.register({ key: 'ctrl+pageup', command: 'conversations.previous' }),
      keybindings.register({ key: 'ctrl+shift+t', command: 'conversations.reopenClosed' }),
      keybindings.register({ key: 'ctrl+f', command: 'conversations.find' }),
      ...Array.from({ length: 9 }, (_, i) =>
        keybindings.register({ key: `ctrl+${i + 1}`, command: 'conversations.goTo', args: [i] }),
      ),
    ];
    register.forEach((disposable) => subscriptions.add(disposable));
    updateContext();
  },
};

function createEmptyState(onNew: () => void): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const title = document.createElement('div');
  title.className = 'empty-state-title';
  title.textContent = t('noConversation');
  const action = document.createElement('button');
  action.className = 'link-button';
  action.textContent = t('newConversation');
  action.addEventListener('click', onNew);
  const hint = document.createElement('kbd');
  hint.textContent = 'Ctrl+N';
  const row = document.createElement('div');
  row.className = 'empty-state-row';
  row.append(action, hint);
  empty.append(title, row);
  return empty;
}
