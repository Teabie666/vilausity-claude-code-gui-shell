/**
 * The content pane right of the conversation: files, diffs, previews and side webview
 * panels as tabs. Offers IContentPane; editors for each kind of input come from the
 * modules that register them in the core editor registry.
 */

import { CommandCategory } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { ICommands, IContextKeys, IEditors, IExtensionHost, IKeybindings, ILayout, IPanels, IWebviewFrames } from '../../core/serviceIds';
import { createServiceId } from '../../core/services';
import { ContentPane } from './contentPane';
import { t } from './messages';
import { createSidePanelHost, createWebviewEditorProvider, removeWebviewTabs } from './webviewTabs';

export type { ContentTab, OpenOptions } from './contentPane';
export const IContentPane = createServiceId<ContentPane>('contentPane');

/** True while focus is inside the content pane (keybindings act on its tabs then). */
const FOCUS_KEY = 'contentPaneFocus';

export const contentPaneModule: ShellModule = {
  id: 'contentPane',
  // Its keybindings override the conversations' ones while the pane has focus.
  dependsOn: ['conversations'],
  activate({ services, subscriptions, logger }) {
    const layout = services.get(ILayout);
    const commands = services.get(ICommands);
    const keybindings = services.get(IKeybindings);
    const contextKeys = services.get(IContextKeys);
    const connection = services.get(IExtensionHost);
    const frames = services.get(IWebviewFrames);

    const pane = new ContentPane(layout, services.get(IEditors), logger, {
      // Webviews in a tab's own window post their messages to that window.
      watchWindow: (target) => frames.watchWindow(target),
    });
    subscriptions.add(services.register(IContentPane, pane));
    subscriptions.add(services.get(IEditors).register(createWebviewEditorProvider(frames, connection)));
    subscriptions.add(services.get(IPanels).registerHost('side', createSidePanelHost(pane)));
    subscriptions.add(connection.onDidDisconnect(() => removeWebviewTabs(pane)));

    const popOut = document.createElement('button');
    popOut.className = 'icon-button icon-pop-out';
    popOut.title = t('moveToNewWindow');
    popOut.setAttribute('aria-label', t('moveToNewWindow'));
    popOut.addEventListener('click', () => pane.popOut());
    pane.actions.appendChild(popOut);

    const updateContext = (): void => {
      contextKeys.set(FOCUS_KEY, pane.hasFocus);
      contextKeys.set('contentPane.hasTabs', pane.tabs.length > 0);
      contextKeys.set('contentPane.visible', layout.contentPaneVisible);
      contextKeys.set('contentPane.canPopOut', pane.canPopOut());
      contextKeys.set('contentPane.floatingFocus', pane.current?.isFloating === true);
      popOut.hidden = !pane.canPopOut();
    };
    subscriptions.add(pane.onDidChangeFocus(updateContext));
    subscriptions.add(pane.onDidChangeActive(updateContext));
    subscriptions.add(pane.onDidClose(updateContext));
    subscriptions.add(pane.onDidChangeFloating(updateContext));
    subscriptions.add(layout.onDidChangeContentPaneVisibility(updateContext));
    updateContext();

    const toggle = document.createElement('button');
    toggle.className = 'icon-button titlebar-button icon-content-pane';
    keybindings.bindTooltip(toggle, t('toggleContentPane'), 'contentPane.toggle');
    subscriptions.add(keybindings.bindLabel(pane.emptyHint, 'quickOpen.show'));
    toggle.setAttribute('aria-label', t('toggleContentPane'));
    toggle.addEventListener('click', () => layout.toggleContentPane());
    const syncToggle = (): void => {
      toggle.classList.toggle('checked', layout.contentPaneVisible);
    };
    syncToggle();
    subscriptions.add(layout.onDidChangeContentPaneVisibility(syncToggle));
    subscriptions.add(layout.addTitleBarItem('right', toggle, 100));

    const focused = FOCUS_KEY;
    const register = [
      commands.register(
        'contentPane.toggle',
        () => {
          layout.toggleContentPane();
          if (layout.contentPaneVisible) {
            pane.focusActive();
          }
        },
        { title: t('toggleContentPane'), category: CommandCategory.view },
      ),
      commands.register('contentPane.closeEditor', () => pane.close(), {
        title: t('closeActiveEditor'),
        category: CommandCategory.view,
        when: 'contentPane.hasTabs',
      }),
      commands.register('contentPane.nextEditor', () => pane.cycle(1), {
        title: t('nextEditor'),
        category: CommandCategory.view,
        when: 'contentPane.hasTabs',
      }),
      commands.register('contentPane.previousEditor', () => pane.cycle(-1), {
        title: t('previousEditor'),
        category: CommandCategory.view,
        when: 'contentPane.hasTabs',
      }),
      commands.register('contentPane.moveToNewWindow', () => pane.popOut(), {
        title: t('moveToNewWindow'),
        category: CommandCategory.view,
        when: 'contentPane.canPopOut',
      }),
      commands.register('contentPane.moveToMainWindow', () => pane.moveBack(), {
        title: t('moveBack'),
        category: CommandCategory.view,
        when: 'contentPane.floatingFocus',
      }),
      keybindings.register({ key: 'ctrl+\\', command: 'contentPane.toggle' }),
      keybindings.register({ key: 'ctrl+w', command: 'contentPane.closeEditor', when: focused }),
      keybindings.register({ key: 'ctrl+f4', command: 'contentPane.closeEditor', when: focused }),
      keybindings.register({ key: 'ctrl+tab', command: 'contentPane.nextEditor', when: focused }),
      keybindings.register({ key: 'ctrl+pagedown', command: 'contentPane.nextEditor', when: focused }),
      keybindings.register({ key: 'ctrl+shift+tab', command: 'contentPane.previousEditor', when: focused }),
      keybindings.register({ key: 'ctrl+pageup', command: 'contentPane.previousEditor', when: focused }),
    ];
    register.forEach((disposable) => subscriptions.add(disposable));
  },
};
