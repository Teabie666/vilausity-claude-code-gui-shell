/**
 * Conversation panels (the extension's `createWebviewPanel`) as tabs above the conversation.
 * One panel is visible at a time; hidden ones keep their iframe (and Claude process)
 * alive, as the extension asks with retainContextWhenHidden.
 *
 * A session opened by a click in the session list is a preview (VS Code's preview editors,
 * the title in italics): another click takes its place, and it closes once another tab shows,
 * unless it was kept: its tab or its row double-clicked, or a message sent in it.
 *
 * The shell can put tabs of its own among them (openShellTab: the setup guide). While one is
 * in front there is no active conversation.
 */

import { Emitter, type Event } from '../../platform/event';
import type { IDisposable } from '../../platform/lifecycle';
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
  /** Opened to look at (see above); closes when another tab shows. */
  readonly isPreview: boolean;
}

interface PanelEntry extends ConversationPanel {
  readonly tab: HTMLElement;
  readonly label: HTMLElement;
  readonly icon: HTMLImageElement;
  iconPath: IconPathDto | undefined;
  isPreview: boolean;
  /** A preview the shell asked the extension to close. */
  closing: boolean;
}

/** A tab the shell draws itself, among the conversations. */
export interface ShellTabOptions {
  readonly title: string;
  /** Its close button was pressed (or it was middle-clicked); the owner disposes the tab. */
  readonly onClose: () => void;
  /** It came to the front to be used: its content takes the focus. */
  readonly onFocus: () => void;
}

export interface ShellTab extends IDisposable {
  /** Holds the content; shown while the tab is in front. */
  readonly container: HTMLElement;
  /** Whether it offers to be closed (its close button). */
  setClosable(closable: boolean): void;
  /** Brings it to the front and focuses it. */
  reveal(): void;
}

interface ShellTabEntry {
  readonly tab: HTMLElement;
  readonly container: HTMLElement;
  readonly options: ShellTabOptions;
  closable: boolean;
}

export class ConversationTabs {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly shellTabs = new Map<string, ShellTabEntry>();
  private shellTabCount = 0;
  /** Most recently active first (panels and shell tabs); picks the next tab when one closes. */
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

  /** Conversations open; shell tabs do not count. */
  get count(): number {
    return this.panels.size;
  }

  /** Every tab in the strip, shell tabs too. */
  get tabCount(): number {
    return this.panels.size + this.shellTabs.size;
  }

  /** The title of the tab in front, a conversation's or a shell tab's. */
  get activeTitle(): string | undefined {
    if (this.activeId === undefined) {
      return undefined;
    }
    return this.panels.get(this.activeId)?.title ?? this.shellTabs.get(this.activeId)?.options.title;
  }

  /** Panels in tab-strip order. */
  get ordered(): ConversationPanel[] {
    return [...this.tabStrip.children].flatMap((tab) => {
      const panel = this.panels.get((tab as HTMLElement).dataset.panelId ?? '');
      return panel ? [panel] : [];
    });
  }

  create(params: PanelCreateParams): void {
    const preview = params.preview === true;
    // A new preview takes the place of the one open.
    const replaced = preview ? [...this.panels.values()].find((entry) => entry.isPreview && !entry.closing) : undefined;
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.classList.toggle('preview', preview);
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
    close.title = t('close');
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
    tab.addEventListener('dblclick', () => this.pin(params.panelId));
    if (replaced) {
      replaced.tab.after(tab);
    } else {
      this.tabStrip.appendChild(tab);
    }

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
      isPreview: preview,
      closing: false,
    };
    this.panels.set(params.panelId, entry);
    this.renderIcon(entry);
    this.countEmitter.fire(this.panels.size);
    if (!params.preserveFocus || this.activeId === undefined) {
      this.activate(params.panelId, !params.preserveFocus);
    }
    if (replaced) {
      this.closePreview(replaced);
    }
  }

  /** A tab of the shell's, at the end of the strip; it comes to the front with `reveal`. */
  openShellTab(options: ShellTabOptions): ShellTab {
    const id = `shell-${++this.shellTabCount}`;
    const tab = document.createElement('div');
    tab.className = 'tab shell-tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.shellTab = id;
    tab.title = options.title;
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = options.title;
    const close = document.createElement('button');
    close.className = 'tab-close icon-button';
    close.title = t('close');
    close.setAttribute('aria-label', t('closeTabLabel'));
    tab.append(label, close);
    const entry: ShellTabEntry = { tab, container: document.createElement('div'), options, closable: true };
    const requestClose = (): void => {
      if (entry.closable) {
        options.onClose();
      }
    };
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      requestClose();
    });
    tab.addEventListener('mousedown', (event) => {
      if (event.button === 0) {
        this.activate(id, true);
      }
    });
    tab.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        requestClose();
      }
    });
    this.tabStrip.appendChild(tab);
    entry.container.className = 'panel';
    entry.container.hidden = true;
    this.area.appendChild(entry.container);
    this.shellTabs.set(id, entry);
    this.countEmitter.fire(this.panels.size);
    return {
      container: entry.container,
      setClosable: (closable) => {
        entry.closable = closable;
        close.hidden = !closable;
      },
      reveal: () => this.activate(id, true),
      dispose: () => this.removeShellTab(id),
    };
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
    if (params.pinned) {
      this.pin(params.panelId);
    }
  }

  /** Keeps a preview: it stays when another tab shows (and the session list shows it open now). */
  pin(panelId: string): void {
    const entry = this.panels.get(panelId);
    if (entry?.isPreview && !entry.closing) {
      entry.isPreview = false;
      entry.tab.classList.remove('preview');
      this.connection.rpc?.notify('panel.didPin', { panelId });
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
      this.activateNext();
    }
  }

  private removeShellTab(id: string): void {
    const entry = this.shellTabs.get(id);
    if (!entry) {
      return;
    }
    this.shellTabs.delete(id);
    this.history = this.history.filter((other) => other !== id);
    entry.tab.remove();
    entry.container.remove();
    this.countEmitter.fire(this.panels.size);
    if (this.activeId === id) {
      this.activateNext();
    }
  }

  /** The tab in front closed: the one used before it comes forward. */
  private activateNext(): void {
    this.activeId = undefined;
    const next = this.history[0] ?? this.panels.keys().next().value ?? this.shellTabs.keys().next().value;
    if (next) {
      this.activate(next, true);
    } else {
      this.activeEmitter.fire(undefined);
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
    const ordered = this.orderedIds();
    if (ordered.length === 0) {
      return;
    }
    const index = ordered.findIndex((id) => id === this.activeId);
    this.activate(ordered[(index + offset + ordered.length) % ordered.length]!, true);
  }

  activateIndex(index: number): void {
    const id = this.orderedIds()[index];
    if (id) {
      this.activate(id, true);
    }
  }

  focusActive(): void {
    if (this.activeId === undefined) {
      return;
    }
    const entry = this.panels.get(this.activeId);
    if (entry) {
      this.frames.focus(entry.webviewId);
    } else {
      this.shellTabs.get(this.activeId)?.options.onFocus();
    }
  }

  refreshIcons(): void {
    for (const entry of this.panels.values()) {
      this.renderIcon(entry);
    }
  }

  /** The ids of every tab (panels and shell tabs) in tab-strip order. */
  private orderedIds(): string[] {
    return [...this.tabStrip.children].flatMap((tab) => {
      const id = (tab as HTMLElement).dataset.panelId ?? (tab as HTMLElement).dataset.shellTab ?? '';
      return this.panels.has(id) || this.shellTabs.has(id) ? [id] : [];
    });
  }

  /** A panel or a shell tab comes to the front; with a shell tab, no conversation is active. */
  private activate(id: string, focus: boolean): void {
    const entry = this.panels.get(id);
    const shellTab = entry ? undefined : this.shellTabs.get(id);
    const shown = entry ?? shellTab;
    if (!shown) {
      return;
    }
    if (this.activeId !== undefined && this.activeId !== id) {
      this.deactivate(this.activeId);
    }
    const changed = this.activeId !== id;
    this.activeId = id;
    this.history = [id, ...this.history.filter((other) => other !== id)];
    shown.tab.classList.add('active');
    shown.tab.setAttribute('aria-selected', 'true');
    shown.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    shown.container.hidden = false;
    if (entry) {
      this.connection.rpc?.notify('panel.didChangeViewState', { panelId: id, active: true, visible: true });
      if (focus) {
        this.frames.focus(entry.webviewId);
      }
    } else if (focus) {
      shellTab!.options.onFocus();
    }
    if (changed) {
      this.activeEmitter.fire(entry);
    }
  }

  private deactivate(id: string): void {
    const previous = this.panels.get(id) ?? this.shellTabs.get(id);
    if (!previous) {
      return;
    }
    previous.tab.classList.remove('active');
    previous.tab.setAttribute('aria-selected', 'false');
    previous.container.hidden = true;
    const panel = this.panels.get(id);
    if (panel) {
      this.connection.rpc?.notify('panel.didChangeViewState', {
        panelId: panel.panelId,
        active: false,
        visible: false,
      });
      this.closePreview(panel);
    }
  }

  /** A preview goes once another tab shows or another preview takes its place. */
  private closePreview(entry: PanelEntry): void {
    if (entry.isPreview && !entry.closing) {
      entry.closing = true;
      this.requestClose(entry.panelId);
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
