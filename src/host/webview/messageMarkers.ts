/**
 * Markers by a conversation's scrollbar, after DeepSeek's web chat: a column of short bars, one
 * for each message of the user's, the one in view in the accent color. Pointing at the column
 * lists the messages' first lines; a click scrolls to one. The column sits left of the
 * scrollbar, centered on the conversation's height, and shows the bars around the current one
 * when there are many. The page hints say what a turn and a user message are; the shell turns
 * the markers off (a setting) and moves between messages by command.
 */

import type { MessageMarkerHints } from '../../platform/protocol';
import { scrollerOf } from './scrollKeeper';

/** At most this many bars; the ones around the current message. */
const MAX_BARS = 15;
/** A turn counts as the one in view once its top is this close below the top of the conversation (px). */
const CURRENT_SLACK_PX = 48;
/** How long the list stays after the pointer leaves it (ms): moving from the bars to the list crosses a gap. */
const HIDE_DELAY_MS = 250;

/** Shell look in the page's theme variables; corners and the shadow are VS Code's (the page has no variables for them). */
const STYLES = `
.vilaus-markers {
  position: fixed;
  z-index: 50;
  display: flex;
  align-items: center;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
}
.vilaus-markers[hidden] { display: none; }
.vilaus-markers * { box-sizing: border-box; }
.vilaus-markers-bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 4px;
  cursor: pointer;
}
.vilaus-marker-bar {
  width: 14px;
  height: 2px;
  border-radius: 1px;
  background: var(--vscode-scrollbarSlider-background);
}
.vilaus-markers-bars:hover .vilaus-marker-bar { background: var(--vscode-scrollbarSlider-hoverBackground); }
.vilaus-markers-bars .vilaus-marker-bar.current { background: var(--vscode-focusBorder); }
.vilaus-markers-list {
  position: absolute;
  right: calc(100% + 2px);
  max-width: 320px;
  max-height: min(60vh, 440px);
  overflow-y: auto;
  padding: 4px 0;
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent));
  border-radius: 8px;
  box-shadow: 0 0 12px rgba(0, 0, 0, 0.14);
}
.vilaus-markers-list[hidden] { display: none; }
.vilaus-marker-item {
  display: block;
  width: 100%;
  min-width: 120px;
  padding: 0 10px;
  overflow: hidden;
  font: inherit;
  line-height: 22px;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: inherit;
  background: none;
  border: none;
  border-radius: 0;
  cursor: pointer;
}
.vilaus-marker-item:hover {
  color: var(--vscode-menu-selectionForeground, inherit);
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
}
.vilaus-marker-item.current { color: var(--vscode-focusBorder); }
.vilaus-marker-item.current:hover { color: var(--vscode-menu-selectionForeground, var(--vscode-focusBorder)); }
`;

export class MessageMarkers {
  private readonly root: HTMLElement;
  private readonly bars: HTMLElement;
  private readonly list: HTMLElement;
  private enabled = true;
  private turns: HTMLElement[] = [];
  private current = -1;
  private scroller: HTMLElement | undefined;
  private scheduled = false;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly hints: MessageMarkerHints) {
    const style = document.createElement('style');
    style.id = '_vilausMarkerStyles';
    style.textContent = STYLES;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = 'vilaus-markers';
    this.root.hidden = true;
    this.bars = document.createElement('div');
    this.bars.className = 'vilaus-markers-bars';
    this.list = document.createElement('div');
    this.list.className = 'vilaus-markers-list';
    this.list.setAttribute('role', 'menu');
    this.list.hidden = true;
    this.root.append(this.list, this.bars);
    document.body.appendChild(this.root);

    this.root.addEventListener('mouseenter', () => this.showList());
    this.root.addEventListener('mouseleave', () => {
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => (this.list.hidden = true), HIDE_DELAY_MS);
    });
    this.bars.addEventListener('click', (event) => {
      const bar = (event.target as Element).closest<HTMLElement>('.vilaus-marker-bar');
      if (bar?.dataset.index) {
        this.reveal(Number(bar.dataset.index));
      }
    });
    // Keep the page's own handlers (a click on its body) out of it.
    for (const type of ['click', 'mousedown', 'pointerdown', 'mouseup', 'contextmenu'] as const) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
    // The page's changes, not its own (which would come back here for ever).
    new MutationObserver((records) => {
      if (records.some((record) => !this.root.contains(record.target))) {
        this.schedule();
      }
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', () => this.schedule());
    document.addEventListener('scroll', () => this.schedule(), { capture: true, passive: true });
    this.schedule();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.schedule();
  }

  /** Scrolls to the user's message before or after the one in view. */
  jump(direction: 'previous' | 'next'): void {
    this.update();
    if (this.turns.length === 0) {
      return;
    }
    const target = direction === 'next' ? this.current + 1 : this.currentTop() < -CURRENT_SLACK_PX ? this.current : this.current - 1;
    this.reveal(Math.min(this.turns.length - 1, Math.max(0, target)));
  }

  private schedule(): void {
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => {
        this.scheduled = false;
        this.update();
      });
    }
  }

  private update(): void {
    this.turns = [...document.querySelectorAll<HTMLElement>(this.hints.turn)].filter((turn) => turn.querySelector(this.hints.userMessage));
    this.scroller = this.turns[0] ? scrollerOf(this.turns[0]) : undefined;
    if (!this.enabled || !this.scroller || this.turns.length < 2) {
      this.root.hidden = true;
      return;
    }
    const view = this.scroller.getBoundingClientRect();
    this.current = Math.max(
      0,
      this.turns.findLastIndex((turn) => turn.getBoundingClientRect().top <= view.top + CURRENT_SLACK_PX),
    );
    this.renderBars();
    this.root.hidden = false;
    // Left of the scrollbar, centered on the conversation.
    const scrollbar = this.scroller.offsetWidth - this.scroller.clientWidth;
    this.root.style.right = `${Math.max(0, window.innerWidth - view.right + scrollbar + 2)}px`;
    this.root.style.top = `${Math.round(view.top + view.height / 2 - this.root.offsetHeight / 2)}px`;
    if (!this.list.hidden) {
      this.renderList();
    }
  }

  /** How far the current turn's top is from the top of the conversation (negative: above it). */
  private currentTop(): number {
    const turn = this.turns[this.current];
    return turn && this.scroller ? turn.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top : 0;
  }

  private renderBars(): void {
    const first = Math.max(0, Math.min(this.current - Math.floor(MAX_BARS / 2), this.turns.length - MAX_BARS));
    const last = Math.min(this.turns.length, first + MAX_BARS);
    const wanted: string[] = [];
    for (let index = first; index < last; index++) {
      wanted.push(`${index}${index === this.current ? '*' : ''}`);
    }
    // Only when it changed: this runs on every scroll.
    if (this.bars.dataset.shown === wanted.join()) {
      return;
    }
    this.bars.dataset.shown = wanted.join();
    this.bars.replaceChildren(
      ...wanted.map((entry) => {
        const index = Number.parseInt(entry, 10);
        const bar = document.createElement('div');
        bar.className = `vilaus-marker-bar${index === this.current ? ' current' : ''}`;
        bar.dataset.index = String(index);
        return bar;
      }),
    );
  }

  private showList(): void {
    clearTimeout(this.hideTimer);
    this.renderList();
    this.list.hidden = false;
    // Its middle level with the bars' middle, within the window.
    const bars = this.bars.getBoundingClientRect();
    const height = this.list.offsetHeight;
    const top = Math.min(Math.max(4 - bars.top, bars.height / 2 - height / 2), window.innerHeight - 4 - bars.top - height);
    this.list.style.top = `${Math.round(top)}px`;
  }

  private renderList(): void {
    const texts = this.turns.map((turn) => firstLine(turn.querySelector(this.hints.userMessage)?.textContent ?? ''));
    // Only when it changed: a list rebuilt under the pointer loses its hover and its clicks.
    const shown = JSON.stringify([this.current, texts]);
    if (this.list.dataset.shown === shown) {
      return;
    }
    this.list.dataset.shown = shown;
    this.list.replaceChildren(
      ...texts.map((text, index) => {
        const item = document.createElement('button');
        item.className = `vilaus-marker-item${index === this.current ? ' current' : ''}`;
        item.setAttribute('role', 'menuitem');
        item.textContent = text;
        item.title = text;
        item.addEventListener('click', () => {
          this.list.hidden = true;
          this.reveal(index);
        });
        return item;
      }),
    );
    this.list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }

  private reveal(index: number): void {
    const turn = this.turns[index];
    const scroller = this.scroller;
    if (!turn || !scroller) {
      return;
    }
    const top = scroller.scrollTop + turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top, behavior: 'smooth' });
  }
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}
