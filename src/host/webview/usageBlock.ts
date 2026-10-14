/**
 * The shell's usage block at the top of a session list: what the window's API provider cost
 * (this conversation, this workspace, all of Claude Code's sessions), in place of the
 * extension's "Account & usage", which prices other APIs' models as Claude's. It is built in
 * the extension's own classes (the bridge names them, `hints.usageBlock`), so it looks like the
 * block it stands for, and goes back first in the list whenever the page renders over it.
 */

import type { UsageBlockHints, UsageViewDto } from '../../platform/protocol';

const MARK = 'data-vilaus-usage';
const COLLAPSED_KEY = 'vilaus.usage.collapsed';
const SVG_NS = 'http://www.w3.org/2000/svg';
/** VS Code's chevron-right codicon. */
const CHEVRON_PATH = 'M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z';

export class UsageBlock {
  private view: UsageViewDto | null = null;
  private collapsed = readCollapsed();
  private readonly header: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly chevron: SVGSVGElement;
  private readonly title: HTMLElement;
  private readonly link: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly note: HTMLElement;
  private readonly caveat: HTMLElement;

  constructor(
    private readonly hints: UsageBlockHints,
    onEditPrices: () => void,
  ) {
    this.header = element('div', hints.header);
    this.toggle = element('button', hints.toggle);
    this.chevron = document.createElementNS(SVG_NS, 'svg');
    this.chevron.setAttribute('viewBox', '0 0 16 16');
    this.chevron.setAttribute('fill', 'currentColor');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', CHEVRON_PATH);
    this.chevron.appendChild(path);
    this.title = element('span', hints.label);
    this.toggle.append(this.chevron, this.title);
    this.toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      writeCollapsed(this.collapsed);
      this.render();
    });
    this.link = element('button', hints.link);
    this.link.addEventListener('click', onEditPrices);
    this.header.append(this.toggle, this.link);

    this.body = element('div', hints.body);
    const section = element('div', hints.section);
    this.rows = element('div', hints.rows);
    this.note = element('button', `${hints.link} vilaus-usage-note`);
    this.note.addEventListener('click', onEditPrices);
    this.caveat = element('div', 'vilaus-usage-caveat');
    section.append(this.rows, this.note, this.caveat);
    this.body.append(section);
    for (const node of [this.header, this.body]) {
      node.setAttribute(MARK, '');
    }

    new MutationObserver(() => this.place()).observe(document.body, { subtree: true, childList: true });
  }

  set(view: UsageViewDto | null): void {
    this.view = view;
    this.render();
  }

  private render(): void {
    const view = this.view;
    if (!view) {
      this.header.remove();
      this.body.remove();
      return;
    }
    this.toggle.setAttribute('aria-expanded', String(!this.collapsed));
    this.toggle.title = view.tooltip;
    this.chevron.setAttribute('class', this.collapsed ? this.hints.chevron : `${this.hints.chevron} ${this.hints.chevronExpanded}`);
    this.title.textContent = view.title;
    this.link.textContent = view.editPrices;
    this.link.title = view.editPricesTitle;
    this.rows.replaceChildren(
      ...view.rows.map((row) => {
        const line = element('div', this.hints.row);
        line.title = row.detail;
        const label = element('span', this.hints.rowLabel);
        label.textContent = row.label;
        const value = element('span', this.hints.rowValue);
        value.textContent = row.value;
        line.append(label, value);
        return line;
      }),
    );
    this.note.textContent = view.unpriced ?? '';
    this.note.hidden = !view.unpriced;
    this.note.title = view.editPricesTitle;
    this.caveat.textContent = view.caveat;
    this.body.hidden = this.collapsed;
    this.place();
  }

  /** First in the list, before the extension's own sections. */
  private place(): void {
    if (!this.view) {
      return;
    }
    const root = document.querySelector<HTMLElement>(this.hints.root);
    if (root && (root.firstElementChild !== this.header || this.header.nextElementSibling !== this.body)) {
      root.prepend(this.header, this.body);
    }
  }
}

/** An element with the extension's classes (`classes` space-separated). */
function element<K extends keyof HTMLElementTagNameMap>(tag: K, classes: string): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = classes;
  return created;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  } catch {
    // Remembered for this page only, then.
  }
}
