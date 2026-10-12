/**
 * A conversation's comments drawn by the shell, below the conversation, for when the blocks
 * cannot sit above the extension's input (it changed, or is not there yet for a while).
 * Same content and events as the blocks in the page.
 */

import type { CommentsHostEvent, CommentsViewDto } from '../../platform/protocol';

export class CommentsFallbackBar {
  readonly element: HTMLElement;
  private view: CommentsViewDto | null = null;
  private userExpanded: boolean | undefined;

  constructor(private readonly report: (event: CommentsHostEvent) => void) {
    this.element = document.createElement('div');
    this.element.className = 'comments-bar';
    this.element.hidden = true;
    this.element.addEventListener('click', (event) => this.onClick(event));
  }

  update(view: CommentsViewDto | null): void {
    this.view = view;
    if (!view) {
      this.userExpanded = undefined;
    }
    this.render();
  }

  set visible(visible: boolean) {
    this.element.hidden = !visible;
  }

  dispose(): void {
    this.element.remove();
  }

  private get collapsed(): boolean {
    return this.userExpanded === undefined ? (this.view?.collapsed ?? false) : !this.userExpanded;
  }

  private render(): void {
    const view = this.view;
    if (!view) {
      this.element.replaceChildren();
      return;
    }
    const { labels } = view;
    const collapsed = this.collapsed;
    const header = div('comments-bar-header');
    const toggle = button(
      `comments-bar-toggle ${collapsed ? 'collapsed' : 'expanded'}`,
      'toggle',
      collapsed ? labels.expand : labels.collapse,
    );
    toggle.textContent = labels.header;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const hint = div('comments-bar-hint');
    hint.textContent = labels.hint;
    header.append(toggle, hint, button('icon-button icon-trash', 'clear', labels.clear));

    const list = div('comments-bar-list');
    list.hidden = collapsed;
    for (const block of view.blocks) {
      const item = div('comments-bar-item');
      item.dataset.id = block.id;
      const head = div('comments-bar-item-head');
      const quote = div('comments-bar-quote');
      quote.textContent = `"${block.quote}"`;
      quote.title = block.quote;
      const source = button('comments-bar-source', 'reveal', block.sourceTitle);
      source.textContent = block.source;
      head.append(
        quote,
        source,
        button('icon-button icon-edit', 'edit', labels.edit),
        button('icon-button icon-close', 'remove', labels.remove),
      );
      const text = div('comments-bar-text');
      text.textContent = block.text;
      item.append(head, text);
      list.appendChild(item);
    }
    this.element.replaceChildren(header, list);
  }

  private onClick(event: MouseEvent): void {
    const target = (event.target as Element).closest<HTMLElement>('button[data-action]');
    const item = target?.closest<HTMLElement>('.comments-bar-item');
    const id = item?.dataset.id;
    switch (target?.dataset.action) {
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
        if (id && item) {
          const rect = item.getBoundingClientRect();
          this.report({ type: 'edit', id, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
        }
        break;
      case 'remove':
        if (id) this.report({ type: 'remove', id });
        break;
    }
  }
}

function div(className: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  return element;
}

function button(className: string, action: string, label: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.dataset.action = action;
  element.title = label;
  element.setAttribute('aria-label', label);
  return element;
}
