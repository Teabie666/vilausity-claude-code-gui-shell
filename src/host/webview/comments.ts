/**
 * Comment blocks above a conversation's message input, inside the extension's page. The
 * shell says what to show (every text final, see CommentsViewDto); this keeps the blocks
 * right before the element the page hints name, however the page re-renders, and reports
 * clicks back. Editing happens in the shell. Events inside the blocks never reach the
 * page's own handlers.
 */

import type { CommentsHostEvent, CommentsViewDto, RectDto } from '../../platform/protocol';

/** Events the page must not see from the blocks (its root listeners would act on them). */
const SHIELDED_EVENTS = [
  'click',
  'dblclick',
  'auxclick',
  'mousedown',
  'mouseup',
  'pointerdown',
  'pointerup',
  'keydown',
  'keyup',
  'keypress',
  'focusin',
  'focusout',
  'contextmenu',
  'dragstart',
] as const;

// Codicons, drawn as masks filled with the text color.
const ICONS = {
  edit: 'M14.236 1.76386C13.2123 0.740172 11.5525 0.740171 10.5289 1.76386L2.65722 9.63549C2.28304 10.0097 2.01623 10.4775 1.88467 10.99L1.01571 14.3755C0.971767 14.5467 1.02148 14.7284 1.14646 14.8534C1.27144 14.9783 1.45312 15.028 1.62432 14.9841L5.00978 14.1151C5.52234 13.9836 5.99015 13.7168 6.36433 13.3426L14.236 5.47097C15.2596 4.44728 15.2596 2.78755 14.236 1.76386ZM11.236 2.47097C11.8691 1.8378 12.8957 1.8378 13.5288 2.47097C14.162 3.10413 14.162 4.1307 13.5288 4.76386L12.75 5.54269L10.4571 3.24979L11.236 2.47097ZM9.75002 3.9569L12.0429 6.24979L5.65722 12.6355C5.40969 12.883 5.10023 13.0595 4.76117 13.1465L2.19447 13.8053L2.85327 11.2386C2.9403 10.8996 3.1168 10.5901 3.36433 10.3426L9.75002 3.9569Z',
  remove:
    'M13.85 13.1502C14.05 13.3502 14.05 13.6602 13.85 13.8602C13.75 13.9602 13.62 14.0102 13.5 14.0102C13.38 14.0102 13.24 13.9602 13.15 13.8602L8 8.71023L2.85 13.8602C2.75 13.9602 2.62 14.0102 2.5 14.0102C2.38 14.0102 2.24 13.9602 2.15 13.8602C1.95 13.6602 1.95 13.3502 2.15 13.1502L7.3 8.00023L2.15 2.85023C1.95 2.65023 1.95 2.34023 2.15 2.14023C2.35 1.94023 2.66 1.94023 2.86 2.14023L8.01 7.29023L13.16 2.14023C13.36 1.94023 13.67 1.94023 13.87 2.14023C14.07 2.34023 14.07 2.65023 13.87 2.85023L8.72 8.00023L13.87 13.1502H13.85Z',
  clear:
    'M14 2H10C10 0.897 9.103 0 8 0C6.897 0 6 0.897 6 2H2C1.724 2 1.5 2.224 1.5 2.5C1.5 2.776 1.724 3 2 3H2.54L3.349 12.708C3.456 13.994 4.55 15 5.84 15H10.159C11.449 15 12.543 13.993 12.65 12.708L13.459 3H13.999C14.275 3 14.499 2.776 14.499 2.5C14.499 2.224 14.275 2 13.999 2H14ZM8 1C8.551 1 9 1.449 9 2H7C7 1.449 7.449 1 8 1ZM11.655 12.625C11.591 13.396 10.934 14 10.16 14H5.841C5.067 14 4.41 13.396 4.346 12.625L3.544 3H12.458L11.656 12.625H11.655ZM7 5.5V11.5C7 11.776 6.776 12 6.5 12C6.224 12 6 11.776 6 11.5V5.5C6 5.224 6.224 5 6.5 5C6.776 5 7 5.224 7 5.5ZM10 5.5V11.5C10 11.776 9.776 12 9.5 12C9.224 12 9 11.776 9 11.5V5.5C9 5.224 9.224 5 9.5 5C9.776 5 10 5.224 10 5.5Z',
  expanded:
    'M3.14598 5.85423L7.64598 10.3542C7.84098 10.5492 8.15798 10.5492 8.35298 10.3542L12.853 5.85423C13.048 5.65923 13.048 5.34223 12.853 5.14723C12.658 4.95223 12.341 4.95223 12.146 5.14723L7.99998 9.29323L3.85398 5.14723C3.65898 4.95223 3.34198 4.95223 3.14698 5.14723C2.95198 5.34223 2.95098 5.65923 3.14598 5.85423Z',
  collapsed:
    'M6.14601 3.14579C5.95101 3.34079 5.95101 3.65779 6.14601 3.85279L10.292 7.99879L6.14601 12.1448C5.95101 12.3398 5.95101 12.6568 6.14601 12.8518C6.34101 13.0468 6.65801 13.0468 6.85301 12.8518L11.353 8.35179C11.548 8.15679 11.548 7.83979 11.353 7.64478L6.85301 3.14479C6.65801 2.94979 6.34101 2.95079 6.14601 3.14579Z',
};

function iconUrl(path: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="${path}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * Shell look (1px lines, theme colors, VS Code's radii) in the page's theme variables. The
 * radii are literal: the page has no --vscode-cornerRadius-* variables.
 */
const STYLES = `
.vilaus-comments {
  margin: 0 0 6px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  line-height: 18px;
  color: var(--vscode-foreground);
  text-align: left;
}
/* None of the page's own corners: the classes below set ours. */
.vilaus-comments * { box-sizing: border-box; border-radius: 0; }
/* Zero specificity: the classes below decide the look. */
:where(.vilaus-comments) button {
  font: inherit;
  color: inherit;
  margin: 0;
  cursor: pointer;
}
.vilaus-comments-header {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  color: var(--vscode-descriptionForeground);
}
.vilaus-comments-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 22px;
  padding: 0 4px 0 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--vscode-foreground);
}
.vilaus-comments-hint::before {
  content: '·';
  margin-right: 6px;
}
.vilaus-comments-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* Right above the conversation's input: the same 8px corners as its box (extension 2.1.282). */
.vilaus-comments-list {
  max-height: 40vh;
  overflow-y: auto;
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, var(--vscode-panel-border, transparent)));
  border-radius: 8px;
  background: var(--vscode-editorWidget-background);
}
.vilaus-comment {
  padding: 3px 4px 4px 8px;
}
.vilaus-comment + .vilaus-comment {
  border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, var(--vscode-panel-border, transparent)));
}
.vilaus-comment-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
}
.vilaus-comment-quote {
  flex: 1 1 auto;
  min-width: 0;
  padding-left: 6px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  border-left: 2px solid var(--vscode-textBlockQuote-border, var(--vscode-descriptionForeground));
  color: var(--vscode-descriptionForeground);
}
.vilaus-comment-source {
  flex: none;
  padding: 0;
  border: none;
  background: none;
  white-space: nowrap;
  color: var(--vscode-textLink-foreground);
}
.vilaus-comment-source:hover {
  color: var(--vscode-textLink-activeForeground);
  text-decoration: underline;
}
.vilaus-comment-actions {
  display: flex;
  flex: none;
  visibility: hidden;
}
.vilaus-comment:hover .vilaus-comment-actions,
.vilaus-comment:focus-within .vilaus-comment-actions {
  visibility: visible;
}
.vilaus-comment-text {
  padding: 1px 0 0 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
}
.vilaus-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
}
.vilaus-icon::before,
.vilaus-comments-toggle::before {
  content: '';
  width: 16px;
  height: 16px;
  background-color: currentColor;
  mask: var(--vilaus-icon) center / 16px no-repeat;
}
.vilaus-icon:hover,
.vilaus-comments-toggle:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.vilaus-comments button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.vilaus-icon-edit { --vilaus-icon: ${iconUrl(ICONS.edit)}; }
.vilaus-icon-remove { --vilaus-icon: ${iconUrl(ICONS.remove)}; }
.vilaus-icon-clear { --vilaus-icon: ${iconUrl(ICONS.clear)}; }
.vilaus-comments-toggle { --vilaus-icon: ${iconUrl(ICONS.expanded)}; }
.vilaus-comments-toggle[aria-expanded='false'] { --vilaus-icon: ${iconUrl(ICONS.collapsed)}; }
`;

export class CommentsHost {
  private view: CommentsViewDto | null = null;
  private readonly root: HTMLElement;
  private anchor: Element | undefined;
  private observer: MutationObserver | undefined;
  /** What the shell was last told; undefined before anything was to be shown. */
  private reported: boolean | undefined;
  /** The user's fold choice while these comments last; undefined: as the shell suggests. */
  private userExpanded: boolean | undefined;

  constructor(
    private readonly selector: string,
    private readonly report: (event: CommentsHostEvent) => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'vilaus-comments';
    // Marks shell DOM in the extension's page.
    this.root.dataset.vilaus = 'comments';
    this.root.addEventListener('click', (event) => this.onClick(event));
    // Buttons do not take focus from the input on mouse clicks (the keyboard still reaches them).
    this.root.addEventListener('mousedown', (event) => {
      if ((event.target as Element).closest('button')) {
        event.preventDefault();
      }
    });
    for (const type of SHIELDED_EVENTS) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  update(view: CommentsViewDto | null): void {
    this.view = view && view.blocks.length > 0 ? view : null;
    if (!this.view) {
      this.userExpanded = undefined;
    }
    this.render();
    if (this.view) {
      this.observe();
    } else {
      this.observer?.disconnect();
      this.observer = undefined;
    }
    this.place();
  }

  /** Watches the page while there are blocks to keep in place. */
  private observe(): void {
    if (this.observer || !document.body) {
      return;
    }
    installStyles();
    this.observer = new MutationObserver(() => this.place());
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  /** Puts the blocks right before the anchor, or takes them out while there is none. */
  private place(): void {
    if (!this.view) {
      this.root.remove();
      this.anchor = undefined;
      return;
    }
    // The common case, on every change the page makes: still in place.
    if (this.anchor?.isConnected && this.root.nextElementSibling === this.anchor) {
      return;
    }
    const anchor = document.querySelector(this.selector);
    if (anchor?.parentElement) {
      anchor.parentElement.insertBefore(this.root, anchor);
      this.anchor = anchor;
    } else {
      this.root.remove();
      this.anchor = undefined;
    }
    const attached = this.anchor !== undefined;
    if (attached !== this.reported) {
      this.reported = attached;
      this.report({ type: 'attached', attached });
    }
  }

  private get collapsed(): boolean {
    return this.userExpanded === undefined ? (this.view?.collapsed ?? false) : !this.userExpanded;
  }

  private render(): void {
    const view = this.view;
    if (!view) {
      this.root.replaceChildren();
      return;
    }
    const { labels } = view;
    const collapsed = this.collapsed;

    const header = element('div', 'vilaus-comments-header');
    const toggle = element('button', 'vilaus-comments-toggle', labels.header);
    toggle.type = 'button';
    toggle.dataset.action = 'toggle';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? labels.expand : labels.collapse;
    const clear = iconButton('clear', labels.clear);
    header.append(toggle, element('span', 'vilaus-comments-hint', labels.hint), clear);

    const list = element('div', 'vilaus-comments-list');
    list.hidden = collapsed;
    for (const block of view.blocks) {
      const item = element('div', 'vilaus-comment');
      item.dataset.id = block.id;
      const head = element('div', 'vilaus-comment-head');
      const quote = element('span', 'vilaus-comment-quote', `"${block.quote}"`);
      quote.title = block.quote;
      const source = element('button', 'vilaus-comment-source', block.source);
      source.type = 'button';
      source.dataset.action = 'reveal';
      source.title = block.sourceTitle;
      const actions = element('span', 'vilaus-comment-actions');
      actions.append(iconButton('edit', labels.edit), iconButton('remove', labels.remove));
      head.append(quote, source, actions);
      item.append(head, element('div', 'vilaus-comment-text', block.text));
      list.appendChild(item);
    }
    this.root.replaceChildren(header, list);
  }

  private onClick(event: MouseEvent): void {
    const button = (event.target as Element).closest<HTMLElement>('button[data-action]');
    if (!button) {
      return;
    }
    const block = button.closest<HTMLElement>('.vilaus-comment');
    const id = block?.dataset.id;
    switch (button.dataset.action) {
      case 'toggle':
        this.userExpanded = this.collapsed;
        this.render();
        break;
      case 'clear':
        this.report({ type: 'clear' });
        break;
      case 'reveal':
        if (id) this.report({ type: 'reveal', id });
        break;
      case 'edit':
        if (id && block) this.report({ type: 'edit', id, rect: toRect(block.getBoundingClientRect()) });
        break;
      case 'remove':
        if (id) this.report({ type: 'remove', id });
        break;
    }
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  if (text !== undefined) {
    created.textContent = text;
  }
  return created;
}

function iconButton(action: 'edit' | 'remove' | 'clear', label: string): HTMLButtonElement {
  const button = element('button', `vilaus-icon vilaus-icon-${action}`);
  button.type = 'button';
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

function toRect(rect: DOMRect): RectDto {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function installStyles(): void {
  if (document.getElementById('_vilausComments')) {
    return;
  }
  const style = document.createElement('style');
  style.id = '_vilausComments';
  style.textContent = STYLES;
  (document.head ?? document.documentElement).appendChild(style);
}
