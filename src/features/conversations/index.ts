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
  IQuickAccess,
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
/** The markers by a conversation's scrollbar, one per message of the user's (host/webview/messageMarkers.ts). */
const MESSAGE_MARKERS = 'vilaus.conversations.messageMarkers';

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
    subscriptions.add(keybindings.bindLabel(emptyState.querySelector('kbd')!, 'conversations.new'));
    // The tabs' close buttons name the keys that close.
    layout.tabs.addEventListener('pointerover', (event) => {
      const close = (event.target as Element).closest<HTMLElement>('.tab-close');
      if (close) {
        close.title = keybindings.tooltip(t('close'), 'conversations.close');
      }
    });

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
        {
          key: MESSAGE_MARKERS,
          section: SettingsSection.workbench,
          order: 11,
          schema: { type: 'boolean', default: true, description: t('messageMarkersSetting') },
        },
      ]),
    );
    // A page loaded later starts with them on: it is told when they are off.
    const markersEnabled = (): boolean => settings.get(MESSAGE_MARKERS, true);
    subscriptions.add(
      frames.onDidLoad(() => {
        if (!markersEnabled()) {
          frames.setMessageMarkers(false);
        }
      }),
    );
    subscriptions.add(settings.onDidChange((keys) => keys.includes(MESSAGE_MARKERS) && frames.setMessageMarkers(markersEnabled())));

    const updateContext = (): void => {
      contextKeys.set('conversations.count', tabs.count);
      contextKeys.set('conversations.hasActive', tabs.active !== undefined);
      // Switching and the tab row count the shell's tabs too (the setup guide).
      contextKeys.set('conversations.multiple', tabs.tabCount > 1);
      emptyState.hidden = tabs.tabCount > 0 || !connection.isConnected;
      layout.tabs.hidden = tabs.tabCount < (settings.get(ALWAYS_SHOW_TABS, false) ? 1 : 2);
    };
    subscriptions.add(tabs.onDidChangeCount(updateContext));
    subscriptions.add(tabs.onDidChangeActive(updateContext));
    subscriptions.add(settings.onDidChange((keys) => keys.includes(ALWAYS_SHOW_TABS) && updateContext()));
    const workspaceName = services.get(IWorkspace).name;
    subscriptions.add(
      tabs.onDidChangeActive(() => {
        const title = tabs.activeTitle;
        document.title = title !== undefined ? `${title} - ${workspaceName} - Vilausity` : `${workspaceName} - Vilausity`;
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
    // The conversation page's own uses of Escape, made keybindings here (the page no longer gets
    // them from a plain Escape, see host/webview/bootstrap.ts): interrupting has no keys by default.
    const playEscape = (action: 'interrupt' | 'rewind') => () => {
      const panel = tabs.active;
      if (panel) {
        frames.playEscape(panel.webviewId, action);
      }
    };
    // The user's messages in the conversation in front, one by one (no keys by default).
    const jumpToMessage = (direction: 'previous' | 'next') => () => {
      const panel = tabs.active;
      if (panel) {
        frames.jumpToMessage(panel.webviewId, direction);
      }
    };
    const register = [
      commands.register('conversations.new', ext(EXT_OPEN_CHAT), { title: t('newConversation'), category: 'Claude' }),
      commands.register('conversations.close', () => tabs.requestClose(), {
        title: t('closeConversation'),
        category: 'Claude',
        when: 'conversations.hasActive',
      }),
      commands.register('conversations.next', () => tabs.cycle(1), {
        title: t('nextConversation'),
        category: 'Claude',
        when: 'conversations.multiple',
      }),
      commands.register('conversations.previous', () => tabs.cycle(-1), {
        title: t('previousConversation'),
        category: 'Claude',
        when: 'conversations.multiple',
      }),
      // One command per tab, as VS Code's "Open Editor at Index": each its own keybinding.
      ...Array.from({ length: 9 }, (_, i) =>
        commands.register(`conversations.goTo${i + 1}`, () => tabs.activateIndex(i), {
          title: t('openConversationAt', i + 1),
          category: 'Claude',
          palette: false,
        }),
      ),
      commands.register('conversations.reopenClosed', ext(EXT_REOPEN_CLOSED), {
        title: t('reopenClosedConversation'),
        category: 'Claude',
      }),
      commands.register('conversations.focusInput', ext(EXT_FOCUS_INPUT), { title: t('focusInput'), category: 'Claude' }),
      commands.register('conversations.interrupt', playEscape('interrupt'), {
        title: t('interrupt'),
        category: 'Claude',
        when: 'conversations.hasActive',
      }),
      commands.register('conversations.rewind', playEscape('rewind'), {
        title: t('rewind'),
        category: 'Claude',
        when: 'conversations.hasActive',
      }),
      commands.register('conversations.previousMessage', jumpToMessage('previous'), {
        title: t('previousMessage'),
        category: 'Claude',
        when: 'conversations.hasActive',
      }),
      commands.register('conversations.nextMessage', jumpToMessage('next'), {
        title: t('nextMessage'),
        category: 'Claude',
        when: 'conversations.hasActive',
      }),
      commands.register('conversations.find', () => find.show(), {
        title: t('findInConversation'),
        category: 'Claude',
        when: 'conversations.hasActive',
      }),
      commands.register('claude.showLogs', ext(EXT_SHOW_LOGS), { title: t('showLogs'), category: 'Claude' }),
      commands.register('claude.logout', ext(EXT_LOGOUT), { title: t('signOut'), category: 'Claude' }),
      keybindings.register({ key: 'ctrl+n', command: 'conversations.new' }),
      keybindings.register({ key: 'ctrl+w', command: 'conversations.close' }),
      // Of Escape with a modifier only Shift is left: Windows takes Alt+Esc and Ctrl+Esc itself.
      keybindings.register({ key: 'shift+escape', command: 'conversations.rewind' }),
      keybindings.register({ key: 'ctrl+tab', command: 'conversations.next' }),
      keybindings.register({ key: 'ctrl+pagedown', command: 'conversations.next' }),
      keybindings.register({ key: 'ctrl+shift+tab', command: 'conversations.previous' }),
      keybindings.register({ key: 'ctrl+pageup', command: 'conversations.previous' }),
      keybindings.register({ key: 'ctrl+shift+t', command: 'conversations.reopenClosed' }),
      keybindings.register({ key: 'ctrl+f', command: 'conversations.find' }),
      ...Array.from({ length: 9 }, (_, i) => keybindings.register({ key: `ctrl+${i + 1}`, command: `conversations.goTo${i + 1}` })),
    ];
    register.forEach((disposable) => subscriptions.add(disposable));
    // In the search with nothing typed, after the recent conversations (features/sessionSearch).
    subscriptions.add(
      services.get(IQuickAccess).registerSearchContributor({
        id: 'newConversation',
        order: 11,
        provide: (query) =>
          query
            ? undefined
            : {
                items: [
                  {
                    label: t('newConversation'),
                    icon: 'add',
                    keybinding: keybindings.labelFor('conversations.new'),
                    accept: () => commands.execute('conversations.new'),
                  },
                ],
              },
      }),
    );
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
  const row = document.createElement('div');
  row.className = 'empty-state-row';
  row.append(action, document.createElement('kbd'));
  empty.append(title, row);
  return empty;
}
