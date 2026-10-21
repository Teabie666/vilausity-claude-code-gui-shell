/**
 * The content pane: a tab strip and one editor per tab, right of the conversation. Which
 * editor shows a tab comes from the core editor registry; this class only manages tabs:
 * opening (with VS Code's preview tabs), activating, dirty markers, closing, and moving a
 * tab into a window of its own (an auxiliary window) and back.
 */

import { Emitter, type Event } from '../../platform/event';
import { DisposableStore, type IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { EditorHost, EditorInput, EditorPane, EditorRegistry } from '../../core/editors';
import type { Layout } from '../../core/layout';
import { AuxWindow } from './auxWindow';
import { t } from './messages';

export interface OpenOptions {
  /** Keep focus where it is (the pane still opens and the tab still activates). */
  readonly preserveFocus?: boolean;
  /** Replace the current preview tab instead of adding one, until edited or pinned. */
  readonly preview?: boolean;
  /** Activate the tab even when it is already open but another tab is active. Default true. */
  readonly activate?: boolean;
}

export interface ContentTab {
  readonly input: EditorInput;
  readonly pane: EditorPane;
  readonly isPreview: boolean;
  readonly isDirty: boolean;
  /** Shown in a window of its own rather than in the content pane. */
  readonly isFloating: boolean;
}

interface TabEntry extends ContentTab {
  readonly element: HTMLElement;
  container: HTMLElement;
  isPreview: boolean;
  isDirty: boolean;
  closing: boolean;
  aux: AuxWindow | undefined;
  readonly auxSubscriptions: DisposableStore;
}

export interface ContentPaneOptions {
  /** Called for each auxiliary window, e.g. to receive messages of webviews shown in it. */
  readonly watchWindow?: (target: Window) => IDisposable;
  /** The tooltip of a tab's unsaved-changes dot (its close button then), asked on each hover. */
  readonly unsavedTooltip?: () => string;
}

export class ContentPane {
  /** Right of the tab strip: buttons for the active tab (e.g. move into a new window). */
  readonly actions: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly body: HTMLElement;
  private readonly empty: HTMLElement;
  /** The keys that open a file, in the empty pane (the module keeps it current). */
  readonly emptyHint: HTMLElement;
  private readonly entries = new Map<string, TabEntry>();
  /** Most recently active first (tabs in the pane); picks the next tab when one closes. */
  private history: string[] = [];
  private activeId: string | undefined;
  /** The floating tab whose window has focus. */
  private focusedFloating: TabEntry | undefined;
  private readonly activeEmitter = new Emitter<ContentTab | undefined>();
  readonly onDidChangeActive: Event<ContentTab | undefined> = this.activeEmitter.event;
  private readonly closeEmitter = new Emitter<ContentTab>();
  readonly onDidClose: Event<ContentTab> = this.closeEmitter.event;
  private readonly focusEmitter = new Emitter<boolean>();
  /** Focus entered or left the pane or a tab's own window. */
  readonly onDidChangeFocus: Event<boolean> = this.focusEmitter.event;
  private readonly floatingEmitter = new Emitter<void>();
  /** A tab moved into a window of its own, or back. */
  readonly onDidChangeFloating: Event<void> = this.floatingEmitter.event;
  private focused = false;

  constructor(
    private readonly layout: Layout,
    private readonly editors: EditorRegistry,
    private readonly logger: ILogger,
    private readonly options: ContentPaneOptions = {},
  ) {
    const root = layout.contentPane;
    this.strip = document.createElement('div');
    this.strip.className = 'content-tabs';
    this.strip.setAttribute('role', 'tablist');
    this.strip.setAttribute('aria-label', t('openEditors'));
    this.actions = document.createElement('div');
    this.actions.className = 'content-actions';
    const header = document.createElement('div');
    header.className = 'content-header';
    header.append(this.strip, this.actions);
    this.body = document.createElement('div');
    this.body.className = 'content-body';
    this.empty = createEmptyState();
    this.emptyHint = this.empty.querySelector('kbd')!;
    this.body.appendChild(this.empty);
    root.append(header, this.body);

    // Focus inside the pane, including into a webview iframe (the iframe element gets focus).
    const updateFocus = (): void => {
      const focused = root.contains(document.activeElement);
      if (focused !== this.focused) {
        this.focused = focused;
        this.focusEmitter.fire(this.hasFocus);
      }
    };
    root.addEventListener('focusin', updateFocus);
    root.addEventListener('focusout', () => setTimeout(updateFocus));
    window.addEventListener('blur', () => setTimeout(updateFocus));
    layout.onDidResizeContentPane(() => this.active?.pane.layout());
    layout.onDidChangeContentPaneVisibility((visible) => {
      this.active?.pane.setVisible(visible);
      if (visible) {
        this.active?.pane.layout();
      }
    });
  }

  /** The active tab of the pane itself. */
  get active(): ContentTab | undefined {
    return this.activeId ? this.entries.get(this.activeId) : undefined;
  }

  /** What commands act on: the floating tab whose window has focus, else the pane's active tab. */
  get current(): ContentTab | undefined {
    return this.focusedFloating ?? this.active;
  }

  /** Every tab: the pane's in strip order, then the floating ones. */
  get tabs(): readonly ContentTab[] {
    return [...this.ordered(), ...this.floating];
  }

  get floating(): readonly ContentTab[] {
    return [...this.entries.values()].filter((entry) => entry.aux !== undefined);
  }

  get hasFocus(): boolean {
    return this.focused || this.focusedFloating !== undefined;
  }

  /** The document that has focus: a floating tab's window's, else the main one. */
  get focusedDocument(): Document {
    return this.focusedFloating?.aux?.document ?? document;
  }

  get(inputId: string): ContentTab | undefined {
    return this.entries.get(inputId);
  }

  /** Opens `input` in a tab (or activates its existing tab) and shows the pane. */
  open(input: EditorInput, options: OpenOptions = {}): ContentTab | undefined {
    const existing = this.entries.get(input.id);
    if (existing) {
      if (options.preview === false) {
        this.pin(existing);
      }
      if (existing.aux) {
        if (!options.preserveFocus) {
          existing.aux.window.focus();
        }
      } else if (options.activate !== false || this.activeId === undefined) {
        this.layout.setContentPaneVisible(true);
        this.activate(existing, !options.preserveFocus);
      }
      return existing;
    }
    const provider = this.editors.resolve(input);
    if (!provider) {
      this.logger.warn(`no editor for ${input.typeId} input ${input.id}`);
      return undefined;
    }
    if (options.preview) {
      const replaced = this.ordered().find((entry) => entry.isPreview && !entry.isDirty);
      if (replaced) {
        this.remove(replaced);
      }
    }
    const container = this.createContainer();
    const element = this.createTabElement(input);
    // Editors may call their host only once the tab exists.
    let entry: TabEntry | undefined;
    const host: EditorHost = {
      setDirty: (dirty) => entry && this.setDirty(entry, dirty),
      pin: () => entry && this.pin(entry),
      close: () => void this.close(input.id),
      activate: () => entry && this.entries.has(input.id) && !entry.aux && this.activate(entry, false),
    };
    let pane: EditorPane;
    try {
      pane = provider.create(container, input, host);
    } catch (error) {
      this.logger.error(`editor ${provider.id} failed to open ${input.id}`, error);
      container.remove();
      return undefined;
    }
    entry = {
      input,
      pane,
      element,
      container,
      isPreview: options.preview === true,
      isDirty: false,
      closing: false,
      aux: undefined,
      auxSubscriptions: new DisposableStore(),
      get isFloating() {
        return this.aux !== undefined;
      },
    };
    element.classList.toggle('preview', entry.isPreview);
    // A new tab goes right of the active one, like VS Code.
    const activeElement = this.activeId ? this.entries.get(this.activeId)?.element : undefined;
    this.strip.insertBefore(element, activeElement?.nextSibling ?? null);
    this.entries.set(input.id, entry);
    this.empty.hidden = true;
    this.layout.setContentPaneVisible(true);
    this.activate(entry, !options.preserveFocus);
    return entry;
  }

  /** Asks the tab's editor (unsaved changes...) and closes the tab. Resolves to whether it closed. */
  async close(inputId: string | undefined = this.current?.input.id): Promise<boolean> {
    const entry = inputId ? this.entries.get(inputId) : undefined;
    if (!entry || entry.closing) {
      return false;
    }
    entry.closing = true;
    let proceed = true;
    try {
      proceed = (await entry.pane.confirmClose?.()) ?? true;
    } catch (error) {
      this.logger.error(`closing ${inputId} failed`, error);
    }
    entry.closing = false;
    if (proceed && this.entries.get(entry.input.id) === entry) {
      this.remove(entry);
    }
    return proceed;
  }

  /** Closes without asking (the owner already decided, e.g. the extension closed it). */
  remove(entryOrId: TabEntry | string): void {
    const entry = typeof entryOrId === 'string' ? this.entries.get(entryOrId) : entryOrId;
    if (!entry || this.entries.get(entry.input.id) !== entry) {
      return;
    }
    const inPane = entry.aux === undefined;
    const wasActive = this.activeId === entry.input.id;
    const hadFocus = this.focused;
    this.entries.delete(entry.input.id);
    this.history = this.history.filter((id) => id !== entry.input.id);
    entry.element.remove();
    try {
      entry.pane.dispose();
    } catch (error) {
      this.logger.error(`disposing the editor of ${entry.input.id} failed`, error);
    }
    if (inPane) {
      entry.container.remove();
    } else {
      this.detachWindow(entry)?.close();
    }
    if (wasActive) {
      this.activeId = undefined;
      const next = this.history[0] ? this.entries.get(this.history[0]) : undefined;
      if (next) {
        this.activate(next, hadFocus);
      } else {
        this.activeEmitter.fire(undefined);
      }
    }
    this.closeEmitter.fire(entry);
    this.updatePaneVisibility();
  }

  /** Whether the tab's editor can move into a window of its own. */
  canPopOut(inputId: string | undefined = this.activeId): boolean {
    const entry = inputId ? this.entries.get(inputId) : undefined;
    return entry !== undefined && entry.aux === undefined && entry.pane.relocate !== undefined;
  }

  /** Moves a tab of the pane into a window of its own. */
  popOut(inputId: string | undefined = this.activeId): boolean {
    const entry = inputId ? this.entries.get(inputId) : undefined;
    if (!entry || entry.aux || !entry.pane.relocate) {
      return false;
    }
    const rect = this.layout.contentPane.getBoundingClientRect();
    const aux = AuxWindow.open(String(Date.now()), entry.input.label, {
      left: window.screenX + Math.max(0, rect.left) + 24,
      top: window.screenY + 24,
      width: Math.max(480, rect.width || window.outerWidth / 2),
      height: Math.max(360, window.outerHeight - 48),
    });
    if (!aux) {
      this.logger.warn(`could not open a window for ${entry.input.id}`);
      return false;
    }
    const wasActive = this.activeId === entry.input.id;
    this.pin(entry);
    entry.aux = aux;
    entry.element.remove();
    entry.pane.relocate(aux.body);
    entry.container.remove();
    entry.container = aux.body;
    entry.pane.setVisible(true);
    entry.pane.layout();
    aux.setDirty(entry.isDirty);
    this.attachWindow(entry, aux);

    this.history = this.history.filter((id) => id !== entry.input.id);
    if (wasActive) {
      this.activeId = undefined;
      const next = this.history[0] ? this.entries.get(this.history[0]) : undefined;
      if (next) {
        this.activate(next, false);
      } else {
        this.activeEmitter.fire(undefined);
      }
    }
    this.floatingEmitter.fire();
    this.updatePaneVisibility();
    entry.pane.focus();
    return true;
  }

  /** Brings a floating tab back into the pane, and closes its window. */
  moveBack(inputId: string | undefined = this.focusedFloating?.input.id): boolean {
    const entry = inputId ? this.entries.get(inputId) : undefined;
    const aux = entry?.aux;
    if (!entry || !aux || !entry.pane.relocate) {
      return false;
    }
    const container = this.createContainer();
    entry.pane.relocate(container);
    entry.container = container;
    this.detachWindow(entry);
    aux.close();
    this.strip.appendChild(entry.element);
    this.empty.hidden = true;
    this.layout.setContentPaneVisible(true);
    this.floatingEmitter.fire();
    this.activate(entry, true, true);
    return true;
  }

  /** Activates the tab `offset` positions away from the active one, wrapping around. */
  cycle(offset: number): void {
    const ordered = this.ordered();
    if (ordered.length === 0) {
      return;
    }
    const index = ordered.findIndex((entry) => entry.input.id === this.activeId);
    this.activate(ordered[(index + offset + ordered.length) % ordered.length]!, true);
  }

  focusActive(): void {
    this.active?.pane.focus();
  }

  /** A tab's title changed (e.g. a webview panel was renamed). */
  setLabel(inputId: string, label: string): void {
    const entry = this.entries.get(inputId);
    const element = entry?.element.querySelector('.tab-label');
    if (entry && element) {
      element.textContent = label;
      entry.element.title = label;
      entry.aux?.setTitle(label);
    }
  }

  private ordered(): TabEntry[] {
    return [...this.strip.children].flatMap((element) => {
      const entry = this.entries.get((element as HTMLElement).dataset.inputId ?? '');
      return entry ? [entry] : [];
    });
  }

  private createContainer(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'content-editor';
    container.hidden = true;
    this.body.appendChild(container);
    return container;
  }

  private attachWindow(entry: TabEntry, aux: AuxWindow): void {
    const subscriptions = entry.auxSubscriptions;
    if (this.options.watchWindow) {
      subscriptions.add(this.options.watchWindow(aux.window));
    }
    subscriptions.add(
      aux.onDidChangeFocus((focused) => {
        if (focused) {
          this.focusedFloating = entry;
        } else if (this.focusedFloating === entry) {
          this.focusedFloating = undefined;
        }
        this.focusEmitter.fire(this.hasFocus);
      }),
    );
    // Closing the window closes the tab, after the editor's say (unsaved changes), as in VS Code.
    aux.onWillClose = () => this.close(entry.input.id);
    aux.onMoveBack = () => this.moveBack(entry.input.id);
    subscriptions.add(
      aux.onDidClose(() => {
        // Still attached: the window went away under us (e.g. destroyed); drop the tab.
        if (entry.aux === aux) {
          this.remove(entry);
        }
      }),
    );
  }

  /** Forgets a floating tab's window; returns it (still open). */
  private detachWindow(entry: TabEntry): AuxWindow | undefined {
    const aux = entry.aux;
    entry.aux = undefined;
    entry.auxSubscriptions.clear();
    if (this.focusedFloating === entry) {
      this.focusedFloating = undefined;
      this.focusEmitter.fire(this.hasFocus);
    }
    if (aux) {
      aux.onWillClose = undefined;
      aux.onMoveBack = undefined;
    }
    return aux;
  }

  private updatePaneVisibility(): void {
    if (this.ordered().length === 0) {
      this.empty.hidden = false;
      // The pane shows while it has something to show.
      this.layout.setContentPaneVisible(false);
    }
  }

  private activate(entry: TabEntry, focus: boolean, force = false): void {
    const previous = this.activeId ? this.entries.get(this.activeId) : undefined;
    const changed = previous !== entry || force;
    if (previous && previous !== entry) {
      previous.element.classList.remove('active');
      previous.element.setAttribute('aria-selected', 'false');
      previous.container.hidden = true;
      previous.pane.setVisible(false);
    }
    this.activeId = entry.input.id;
    this.history = [entry.input.id, ...this.history.filter((id) => id !== entry.input.id)];
    entry.element.classList.add('active');
    entry.element.setAttribute('aria-selected', 'true');
    entry.element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (changed) {
      entry.container.hidden = false;
      entry.pane.setVisible(this.layout.contentPaneVisible);
      entry.pane.layout();
    }
    if (focus) {
      entry.pane.focus();
    }
    if (changed) {
      this.activeEmitter.fire(entry);
    }
  }

  private pin(entry: TabEntry): void {
    if (entry.isPreview) {
      entry.isPreview = false;
      entry.element.classList.remove('preview');
    }
  }

  private setDirty(entry: TabEntry, dirty: boolean): void {
    if (entry.isDirty === dirty) {
      return;
    }
    entry.isDirty = dirty;
    entry.element.classList.toggle('dirty', dirty);
    entry.aux?.setDirty(dirty);
    if (dirty) {
      this.pin(entry);
    }
  }

  private createTabElement(input: EditorInput): HTMLElement {
    const tab = document.createElement('div');
    tab.className = 'tab content-tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.inputId = input.id;
    tab.title = input.tooltip ?? input.label;
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = input.label;
    tab.appendChild(label);
    if (input.description) {
      const description = document.createElement('span');
      description.className = 'tab-description';
      description.textContent = input.description;
      tab.appendChild(description);
    }
    const close = document.createElement('button');
    close.className = 'tab-close icon-button';
    close.title = t('closeEditor');
    close.setAttribute('aria-label', t('closeEditor'));
    close.addEventListener('pointerenter', () => {
      const unsaved = tab.classList.contains('dirty') ? this.options.unsavedTooltip?.() : undefined;
      close.title = unsaved ?? t('closeEditor');
    });
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.close(input.id);
    });
    tab.appendChild(close);
    tab.addEventListener('mousedown', (event) => {
      const entry = this.entries.get(input.id);
      if (event.button === 0 && entry && !entry.aux) {
        this.activate(entry, true);
      }
    });
    tab.addEventListener('dblclick', () => {
      const entry = this.entries.get(input.id);
      if (entry) {
        this.pin(entry);
      }
    });
    tab.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        void this.close(input.id);
      }
    });
    return tab;
  }
}

function createEmptyState(): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  const title = document.createElement('div');
  title.className = 'empty-state-title';
  title.textContent = t('noOpenEditors');
  const row = document.createElement('div');
  row.className = 'empty-state-row';
  const label = document.createElement('span');
  label.textContent = t('openFileHint');
  row.append(label, document.createElement('kbd'));
  empty.append(title, row);
  return empty;
}
