/**
 * The window's regions:
 *
 *   titlebar: [left items][tabs][right items][native window controls]
 *   workbench: [sidebar | sash | main | sash | content pane]
 *   overlays (toasts, quick input, dialogs)
 *
 * Visibility and widths of the sidebar and the content pane are per-user UI state kept in
 * localStorage.
 */

import { Emitter, type Event } from '../platform/event';
import type { IDisposable } from '../platform/lifecycle';

const STORAGE_KEY = 'vilaus.layout.v1';
const SIDEBAR_MIN = 180;
const SIDEBAR_DEFAULT = 280;
const CONTENT_MIN = 240;
/** The conversation keeps at least this much when the content pane grows. */
const MAIN_MIN = 320;
/** First time the content pane opens: this share of the window. */
const CONTENT_DEFAULT_SHARE = 0.45;

interface LayoutState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  contentVisible: boolean;
  /** 0 until the pane is first shown. */
  contentWidth: number;
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`#${id} missing from index.html`);
  }
  return found;
}

export type TitleBarSide = 'left' | 'right';

export class Layout {
  readonly titleBarLeft = element('titlebar-left');
  readonly titleBarRight = element('titlebar-right');
  /** The middle of the title bar (the search box). */
  readonly titleBarCenter = element('titlebar-center');
  readonly tabs = element('tabs');
  readonly sidebar = element('sidebar');
  readonly main = element('main');
  readonly contentPane = element('content-pane');
  readonly overlays = element('overlays');
  private readonly sidebarSash = element('sidebar-sash');
  private readonly contentSash = element('content-sash');
  private readonly state: LayoutState;
  /** Widths asked for while a wide tab shows (`widenContentPane`); 0 once the user drags the sash. */
  private readonly widenings = new Set<{ width: number }>();
  private readonly sidebarEmitter = new Emitter<boolean>();
  readonly onDidChangeSidebarVisibility: Event<boolean> = this.sidebarEmitter.event;
  private readonly contentEmitter = new Emitter<boolean>();
  readonly onDidChangeContentPaneVisibility: Event<boolean> = this.contentEmitter.event;
  private readonly resizeEmitter = new Emitter<void>();
  /** The content pane changed size (sash drag, window resize, shown). */
  readonly onDidResizeContentPane: Event<void> = this.resizeEmitter.event;

  constructor() {
    this.state = loadState();
    this.applySidebar();
    this.applyContent();
    this.installSash(this.sidebarSash, {
      get: () => this.state.sidebarWidth,
      set: (width) => {
        this.state.sidebarWidth = width;
        this.sidebar.style.width = `${width}px`;
      },
      clamp: (width) => Math.round(Math.min(Math.max(SIDEBAR_MIN, window.innerWidth / 2), Math.max(SIDEBAR_MIN, width))),
      direction: 1,
      reset: () => SIDEBAR_DEFAULT,
    });
    this.installSash(this.contentSash, {
      get: () => this.contentWidth(),
      set: (width) => {
        // The user's width from now on, the wide tab's included.
        this.widenings.forEach((widening) => (widening.width = 0));
        this.state.contentWidth = width;
        this.contentPane.style.width = `${width}px`;
        this.resizeEmitter.fire();
      },
      clamp: (width) => this.clampContentWidth(width),
      direction: -1,
      reset: () => this.defaultContentWidth(),
    });
    window.addEventListener('resize', () => {
      if (this.state.contentVisible) {
        const clamped = this.clampContentWidth(this.state.contentWidth);
        if (clamped !== this.state.contentWidth) {
          this.state.contentWidth = clamped;
        }
        this.contentPane.style.width = `${this.contentWidth()}px`;
        this.resizeEmitter.fire();
      }
    });
  }

  /**
   * Makes the content pane at least `width` wide (as far as the window allows) until disposed:
   * a tab that needs the room, while it shows. The user's own width comes back after, unless
   * they drag the sash meanwhile, which sets it.
   */
  widenContentPane(width: number): IDisposable {
    const widening = { width };
    this.widenings.add(widening);
    this.applyContentWidth();
    return {
      dispose: () => {
        if (this.widenings.delete(widening)) {
          this.applyContentWidth();
        }
      },
    };
  }

  /** The width shown: the user's, or wider while a tab asks for it. */
  private contentWidth(): number {
    return this.clampContentWidth(Math.max(this.state.contentWidth, ...[...this.widenings].map((widening) => widening.width)));
  }

  private applyContentWidth(): void {
    const width = `${this.contentWidth()}px`;
    if (this.state.contentVisible && this.contentPane.style.width !== width) {
      this.contentPane.style.width = width;
      this.resizeEmitter.fire();
    }
  }

  get sidebarVisible(): boolean {
    return this.state.sidebarVisible;
  }

  setSidebarVisible(visible: boolean): void {
    if (visible === this.state.sidebarVisible) {
      return;
    }
    this.state.sidebarVisible = visible;
    this.applySidebar();
    saveState(this.state);
    this.sidebarEmitter.fire(visible);
  }

  toggleSidebar(): void {
    this.setSidebarVisible(!this.state.sidebarVisible);
  }

  get contentPaneVisible(): boolean {
    return this.state.contentVisible;
  }

  setContentPaneVisible(visible: boolean): void {
    if (visible === this.state.contentVisible) {
      return;
    }
    this.state.contentVisible = visible;
    this.applyContent();
    saveState(this.state);
    this.contentEmitter.fire(visible);
    if (visible) {
      this.resizeEmitter.fire();
    }
  }

  toggleContentPane(): void {
    this.setContentPaneVisible(!this.state.contentVisible);
  }

  /**
   * Where quick input (the search, commands, pickers) goes across the window: centered on
   * the middle of the title bar (the search box) rather than on the window, since the
   * title bar's sides are not always as wide as each other (a long provider name on the
   * left); kept between the window's left edge and its buttons. The left of a box `width`
   * wide, in window coordinates.
   */
  quickInputLeft(width: number): number {
    const margin = 8;
    const center = this.titleBarCenter.getBoundingClientRect();
    const controls = document.querySelector('.titlebar-main .titlebar-controls-space')?.getBoundingClientRect();
    const right = (controls && controls.width > 0 ? controls.left : window.innerWidth) - margin;
    const wanted = center.width > 0 ? center.left + center.width / 2 - width / 2 : (window.innerWidth - width) / 2;
    return Math.round(Math.max(margin, Math.min(wanted, right - width)));
  }

  /** Adds an element to the title bar; lower `order` sits further left. */
  addTitleBarItem(side: TitleBarSide, item: HTMLElement, order = 0): IDisposable {
    const container = side === 'left' ? this.titleBarLeft : this.titleBarRight;
    item.dataset.order = String(order);
    const next = [...container.children].find((child) => Number((child as HTMLElement).dataset.order) > order);
    container.insertBefore(item, next ?? null);
    return { dispose: () => item.remove() };
  }

  private applySidebar(): void {
    this.sidebar.hidden = !this.state.sidebarVisible;
    this.sidebarSash.hidden = !this.state.sidebarVisible;
    this.sidebar.style.width = `${this.state.sidebarWidth}px`;
    document.body.classList.toggle('sidebar-visible', this.state.sidebarVisible);
  }

  private applyContent(): void {
    const visible = this.state.contentVisible;
    if (visible && this.state.contentWidth === 0) {
      this.state.contentWidth = this.defaultContentWidth();
    }
    this.contentPane.hidden = !visible;
    this.contentSash.hidden = !visible;
    this.contentPane.style.width = `${this.contentWidth()}px`;
    document.body.classList.toggle('content-pane-visible', visible);
  }

  private defaultContentWidth(): number {
    return this.clampContentWidth(Math.round(window.innerWidth * CONTENT_DEFAULT_SHARE));
  }

  private clampContentWidth(width: number): number {
    const sidebar = this.state.sidebarVisible ? this.state.sidebarWidth : 0;
    const max = Math.max(CONTENT_MIN, window.innerWidth - sidebar - MAIN_MIN);
    return Math.round(Math.min(max, Math.max(CONTENT_MIN, width)));
  }

  /** `direction` 1: dragging right grows the region (sidebar); -1: dragging left does (content pane). */
  private installSash(
    sash: HTMLElement,
    region: {
      get(): number;
      set(width: number): void;
      clamp(width: number): number;
      direction: 1 | -1;
      reset(): number;
    },
  ): void {
    sash.addEventListener('pointerdown', (start) => {
      start.preventDefault();
      sash.setPointerCapture(start.pointerId);
      // iframes swallow pointer events; disable them while dragging.
      document.body.classList.add('resizing');
      const initialWidth = region.get();
      const onMove = (move: PointerEvent): void => {
        region.set(region.clamp(initialWidth + region.direction * (move.clientX - start.clientX)));
      };
      const onUp = (): void => {
        document.body.classList.remove('resizing');
        sash.removeEventListener('pointermove', onMove);
        sash.removeEventListener('pointerup', onUp);
        saveState(this.state);
      };
      sash.addEventListener('pointermove', onMove);
      sash.addEventListener('pointerup', onUp);
    });
    sash.addEventListener('dblclick', () => {
      region.set(region.clamp(region.reset()));
      saveState(this.state);
    });
  }
}

function loadState(): LayoutState {
  const defaults: LayoutState = { sidebarVisible: true, sidebarWidth: SIDEBAR_DEFAULT, contentVisible: false, contentWidth: 0 };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<LayoutState>;
    return {
      sidebarVisible: parsed.sidebarVisible ?? defaults.sidebarVisible,
      sidebarWidth: typeof parsed.sidebarWidth === 'number' ? Math.max(SIDEBAR_MIN, parsed.sidebarWidth) : SIDEBAR_DEFAULT,
      // The pane opens when something is shown in it; at startup it is empty.
      contentVisible: false,
      contentWidth: typeof parsed.contentWidth === 'number' ? Math.max(0, parsed.contentWidth) : 0,
    };
  } catch {
    return defaults;
  }
}

function saveState(state: LayoutState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (e.g. a locked profile); layout just isn't remembered.
  }
}
