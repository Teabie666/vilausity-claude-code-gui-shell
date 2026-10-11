/**
 * Conversation panels (the extension's `createWebviewPanel`) as tabs above the conversation.
 * One panel is visible at a time; hidden ones keep their iframe (and Claude process)
 * alive, as the extension asks with retainContextWhenHidden.
 */

import { Emitter, type Event } from '../../platform/event';
import type { IconPathDto, PanelCreateParams, PanelUpdateParams } from '../../platform/protocol';
import type { ExtensionHostConnection } from '../../core/extensionHost';
import type { ThemeService } from '../../core/themes';
import { isDarkTheme } from '../../core/themes';
import { t } from './messages';
import type { WebviewFrames } from '../../core/webviewFrames';

export interface ConversationPanel {
  readonly panelId: string;
  readonly webviewId: string;
  readonly viewType: string;
  title: string;
  /** Holds the panel's iframe; other modules may add UI below it (it is a column). */
  readonly container: HTMLElement;
}

interface PanelEntry extends ConversationPanel {
  readonly tab: HTMLElement;
  readonly label: HTMLElement;
  readonly icon: HTMLImageElement;
  iconPath: IconPathDto | undefined;
}

export class ConversationTabs {
  private readonly panels = new Map<string, PanelEntry>();
  /** Most recently active first; picks the next panel when one closes. */
  private history: string[] = [];
  private activeId: string | undefined;
  private readonly activeEmitter = new Emitter<ConversationPanel | undefined>();
  readonly onDidChangeActive: Event<ConversationPanel | undefined> = this.activeEmitter.event;
  private readonly countEmitter = new Emitter<number>();
  readonly onDidChangeCount: Event<number> = this.countEmitter.event;

  constructor(
    private readonly tabStrip: HTMLElement,
    private readonly area: HTMLElement,
    private readonly frames: WebviewFrames,
    private readonly connection: ExtensionHostConnection,
    private readonly themes: ThemeService,
  ) {}

  get active(): ConversationPanel | undefined {
    return this.activeId ? this.panels.get(this.activeId) : undefined;
  }

  get count(): number {
    return this.panels.size;
  }

  /** Panels in tab-strip order. */
  get ordered(): ConversationPanel[] {
    return [...this.tabStrip.children].flatMap((tab) => {
      const panel = this.panels.get((tab as HTMLElement).dataset.panelId ?? '');
      return panel ? [panel] : [];
    });
  }

  create(params: PanelCreateParams): void {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.panelId = params.panelId;
    tab.title = params.title;
    const icon = document.createElement('img');
    icon.className = 'tab-icon';
    icon.alt = '';
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = params.title;
    const close = document.createElement('button');
    close.className = 'tab-close icon-button';
    close.title = t('closeTab');
    close.setAttribute('aria-label', t('closeTabLabel'));
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      this.requestClose(params.panelId);
    });
    tab.append(icon, label, close);
    tab.addEventListener('mousedown', (event) => {
      if (event.button === 0) {
        this.activate(params.panelId, true);
      }
    });
    tab.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        this.requestClose(params.panelId);
      }
    });
    this.tabStrip.appendChild(tab);

    const container = document.createElement('div');
    container.className = 'panel';
    container.hidden = true;
    this.area.appendChild(container);
    this.frames.create(params.webviewId, params.viewType, container, params.title);

    const entry: PanelEntry = {
      panelId: params.panelId,
      webviewId: params.webviewId,
      viewType: params.viewType,
      title: params.title,
      tab,
      label,
      icon,
      container,
      iconPath: params.iconPath,
    };
    this.panels.set(params.panelId, entry);
    this.renderIcon(entry);
    this.countEmitter.fire(this.panels.size);
    if (!params.preserveFocus || this.activeId === undefined) {
      this.activate(params.panelId, !params.preserveFocus);
    }
  }

  update(params: PanelUpdateParams): void {
    const entry = this.panels.get(params.panelId);
    if (!entry) {
      return;
    }
    if (params.title !== undefined) {
      entry.title = params.title;
      entry.label.textContent = params.title;
      entry.tab.title = params.title;
      if (entry.panelId === this.activeId) {
        this.activeEmitter.fire(entry);
      }
    }
    if (params.iconPath !== undefined) {
      entry.iconPath = params.iconPath ?? undefined;
      this.renderIcon(entry);
    }
  }

  reveal(panelId: string, preserveFocus: boolean): void {
    this.activate(panelId, !preserveFocus);
  }

  remove(panelId: string): void {
    const entry = this.panels.get(panelId);
    if (!entry) {
      return;
    }
    this.panels.delete(panelId);
    this.history = this.history.filter((id) => id !== panelId);
    this.frames.dispose(entry.webviewId);
    entry.tab.remove();
    entry.container.remove();
    this.countEmitter.fire(this.panels.size);
    if (this.activeId === panelId) {
      this.activeId = undefined;
      const next = this.history[0] ?? this.panels.keys().next().value;
      if (next) {
        this.activate(next, true);
      } else {
        this.activeEmitter.fire(undefined);
      }
    }
  }

  /** The extension host is gone: drop every tab without notifying it. */
  clear(): void {
    for (const panelId of [...this.panels.keys()]) {
      this.remove(panelId);
    }
  }

  requestClose(panelId: string | undefined = this.activeId): void {
    if (panelId) {
      // The extension decides; it answers with panel.dispose.
      this.connection.rpc?.notify('panel.didClose', { panelId });
    }
  }

  /** Activates the tab `offset` positions away from the active one, wrapping around. */
  cycle(offset: number): void {
    const ordered = this.ordered;
    if (ordered.length === 0) {
      return;
    }
    const index = ordered.findIndex((panel) => panel.panelId === this.activeId);
    const next = ordered[(index + offset + ordered.length) % ordered.length]!;
    this.activate(next.panelId, true);
  }

  activateIndex(index: number): void {
    const panel = this.ordered[index];
    if (panel) {
      this.activate(panel.panelId, true);
    }
  }

  focusActive(): void {
    const entry = this.activeId ? this.panels.get(this.activeId) : undefined;
    if (entry) {
      this.frames.focus(entry.webviewId);
    }
  }

  refreshIcons(): void {
    for (const entry of this.panels.values()) {
      this.renderIcon(entry);
    }
  }

  private activate(panelId: string, focus: boolean): void {
    const entry = this.panels.get(panelId);
    if (!entry) {
      return;
    }
    const previous = this.activeId ? this.panels.get(this.activeId) : undefined;
    if (previous && previous !== entry) {
      previous.tab.classList.remove('active');
      previous.tab.setAttribute('aria-selected', 'false');
      previous.container.hidden = true;
      this.connection.rpc?.notify('panel.didChangeViewState', {
        panelId: previous.panelId,
        active: false,
        visible: false,
      });
    }
    const changed = this.activeId !== panelId;
    this.activeId = panelId;
    this.history = [panelId, ...this.history.filter((id) => id !== panelId)];
    entry.tab.classList.add('active');
    entry.tab.setAttribute('aria-selected', 'true');
    entry.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    entry.container.hidden = false;
    this.connection.rpc?.notify('panel.didChangeViewState', { panelId, active: true, visible: true });
    if (focus) {
      this.frames.focus(entry.webviewId);
    }
    if (changed) {
      this.activeEmitter.fire(entry);
    }
  }

  private renderIcon(entry: PanelEntry): void {
    const path = entry.iconPath;
    if (!path) {
      entry.icon.hidden = true;
      return;
    }
    entry.icon.src = isDarkTheme(this.themes.current) ? path.dark : path.light;
    entry.icon.hidden = false;
  }
}
