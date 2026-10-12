/**
 * Back and forward between the tabs used, like a browser's or VS Code's Go Back: the
 * conversation tabs and the content pane's tabs are in one history. Alt+Left / Alt+Right,
 * and the mouse's back and forward buttons (main hears those from Windows).
 *
 * Also Escape on a tab looked at: it closes the tab, and the tab used before comes back.
 */

import type { KeyEventDto } from '../../platform/protocol';
import { CommandCategory } from '../../core/messages';
import type { ShellModule } from '../../core/module';
import { ICommands, IKeybindings, ILayout, INative, IWebviewFrames } from '../../core/serviceIds';
import { IContentPane } from '../contentPane';
import { IConversations } from '../conversations';
import { NavigationHistory } from './history';
import { t } from './messages';

/** A mouse button press reported twice (by the page and as an app command) comes this close together, the same way (ms). */
const SAME_PRESS_MS = 150;

/** A tab: a conversation panel, or a content pane tab by its input. */
export interface TabLocation {
  readonly area: 'conversation' | 'content';
  readonly id: string;
}

export const navigationModule: ShellModule = {
  id: 'navigation',
  dependsOn: ['conversations', 'contentPane'],
  activate({ services, subscriptions }) {
    const conversations = services.get(IConversations);
    const pane = services.get(IContentPane);
    const layout = services.get(ILayout);
    const commands = services.get(ICommands);
    const keybindings = services.get(IKeybindings);
    const frames = services.get(IWebviewFrames);
    const history = new NavigationHistory<TabLocation>((a, b) => a.area === b.area && a.id === b.id);

    // The active conversation's event fires on a new title too: only a change of tab counts.
    let activeConversation: string | undefined;
    subscriptions.add(
      conversations.onDidChangeActive((panel) => {
        if (panel && panel.panelId !== activeConversation) {
          history.push({ area: 'conversation', id: panel.panelId });
        }
        activeConversation = panel?.panelId;
      }),
    );
    subscriptions.add(pane.onDidChangeActive((tab) => tab && history.push({ area: 'content', id: tab.input.id })));
    subscriptions.add(pane.onDidClose((tab) => history.remove((entry) => entry.area === 'content' && entry.id === tab.input.id)));
    subscriptions.add(
      conversations.onDidChangeCount(() => {
        const open = new Set(conversations.ordered.map((panel) => panel.panelId));
        history.remove((entry) => entry.area === 'conversation' && !open.has(entry.id));
      }),
    );

    const exists = (entry: TabLocation): boolean =>
      entry.area === 'conversation' ? conversations.ordered.some((panel) => panel.panelId === entry.id) : pane.get(entry.id) !== undefined;
    // Going to a tab that is on screen already would seem to do nothing: it is passed over.
    const shown = (entry: TabLocation): boolean =>
      entry.area === 'conversation'
        ? conversations.active?.panelId === entry.id
        : layout.contentPaneVisible && pane.active?.input.id === entry.id;
    const usable = (entry: TabLocation): boolean => exists(entry) && !shown(entry);
    const go = (entry: TabLocation | undefined): void => {
      if (entry?.area === 'conversation') {
        conversations.reveal(entry.id, false);
      } else if (entry) {
        const tab = pane.get(entry.id);
        if (tab) {
          pane.open(tab.input);
        }
      }
    };

    subscriptions.add(
      commands.register('navigation.back', () => go(history.back(usable)), { title: t('goBack'), category: CommandCategory.view }),
    );
    subscriptions.add(
      commands.register('navigation.forward', () => go(history.forward(usable)), { title: t('goForward'), category: CommandCategory.view }),
    );
    subscriptions.add(keybindings.register({ key: 'alt+left', command: 'navigation.back' }));
    subscriptions.add(keybindings.register({ key: 'alt+right', command: 'navigation.forward' }));

    // The mouse's back and forward buttons. The pages report them: this one here, a webview's
    // through its script. Windows sends them as app commands too, which main passes on, but
    // only where no page takes the mouse (the title bar). A press heard twice counts once.
    let lastMouse = { direction: '', at: Number.NEGATIVE_INFINITY };
    const mouseNavigate = (direction: 'back' | 'forward'): void => {
      const now = Date.now();
      if (direction !== lastMouse.direction || now - lastMouse.at >= SAME_PRESS_MS) {
        lastMouse = { direction, at: now };
        void commands.execute(direction === 'back' ? 'navigation.back' : 'navigation.forward');
      }
    };
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button === 3 || event.button === 4) {
        event.preventDefault();
        mouseNavigate(event.button === 3 ? 'back' : 'forward');
      }
    };
    window.addEventListener('mouseup', onMouseUp, true);
    subscriptions.add({ dispose: () => window.removeEventListener('mouseup', onMouseUp, true) });
    subscriptions.add(frames.onDidRequestNavigate(mouseNavigate));
    subscriptions.add(services.get(INative).on('navigate', ({ direction }) => mouseNavigate(direction)));

    /**
     * An Escape nothing took (a menu, a widget, the editor's own use of it) closes the tab it
     * was pressed in: a content pane tab, or a conversation in preview. A conversation of its
     * own stays (closing it by mistake would lose the place), and so does a tab with unsaved
     * changes or whose closing decides something (`EditorPane.closesOnEscape`).
     */
    const closeOnEscape = (target: Element): void => {
      const tab = pane.active;
      if (tab && layout.contentPane.contains(target)) {
        if (!tab.isDirty && tab.pane.closesOnEscape !== false) {
          closeContentTab(tab.input.id);
        }
        return;
      }
      const panel = conversations.active;
      if (panel?.isPreview && panel.container.contains(target)) {
        // The conversation used before comes back (conversations picks it).
        conversations.requestClose(panel.panelId);
      }
    };
    // Then the tab used before comes back (not one in a window of its own). After the close:
    // the pane gives the focus to its next tab as the closed one goes.
    const closeContentTab = (id: string): void => {
      const previous = history.previous(
        (entry) =>
          !(entry.area === 'content' && entry.id === id) &&
          exists(entry) &&
          (entry.area === 'conversation' || pane.get(entry.id)?.isFloating === false),
      );
      void pane.close(id).then(() => {
        if (previous) {
          go(previous);
        } else {
          conversations.focusActive();
        }
      });
    };
    const isPlainEscape = (event: KeyEventDto): boolean =>
      event.key === 'Escape' && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && !event.repeat;
    // The shell's own page: whether the key was used is known once every listener had its turn.
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (isPlainEscape(event) && !event.isComposing && target instanceof Element) {
        setTimeout(() => !event.defaultPrevented && closeOnEscape(target));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    subscriptions.add({ dispose: () => window.removeEventListener('keydown', onKeyDown) });
    // A webview's page: its script reports only an Escape the page did not use.
    subscriptions.add(
      frames.onDidKeyDown(({ webviewId, event }) => {
        const iframe = frames.element(webviewId);
        if (isPlainEscape(event) && iframe) {
          closeOnEscape(iframe);
        }
      }),
    );
  },
};
