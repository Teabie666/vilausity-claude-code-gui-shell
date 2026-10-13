/**
 * The API provider of each session in a session list: a square in the provider's accent
 * before the row's title (its name on hover), and a toggle next to the filters that keeps only
 * the rows of the window's provider (rows whose provider cannot be told stay). The bridge names
 * the rows and the filter button (`hints.sessionRows`, `hints.statusFilter`); main works out
 * the providers (the `sessionProviders` control).
 */

import type { SessionProvidersDto, SessionRowHints } from '../../platform/protocol';

const MARK_CLASS = 'vilaus-provider-mark';
const TOGGLE_CLASS = 'vilaus-provider-filter';
/** On a row of another provider while only the window's are shown. */
const OTHER_ATTRIBUTE = 'data-vilaus-other-provider';

/**
 * The status filter's button, never the toggle: that one carries the button's classes, and once
 * the page draws the button anew after it, a plain look-up finds the toggle first (which then
 * keeps moving itself after itself, a mutation each time).
 */
export function filterButtonOnly(selector: string): string {
  return `:is(${selector}):not(.${TOGGLE_CLASS})`;
}

export class SessionProviderMarks {
  private view: SessionProvidersDto | null = null;
  private readonly toggle: HTMLButtonElement;
  private readonly swatch: HTMLElement;

  constructor(
    private readonly rows: SessionRowHints,
    /** The status filter's button: the toggle goes right after it, in its look. */
    private readonly filterButton: string,
    onToggle: () => void,
  ) {
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.swatch = document.createElement('span');
    this.swatch.className = MARK_CLASS;
    this.toggle.append(this.swatch);
    this.toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onToggle();
    });
    new MutationObserver(() => this.update()).observe(document.body, { subtree: true, childList: true });
  }

  set(view: SessionProvidersDto | null): void {
    this.view = view;
    this.update();
  }

  private update(): void {
    const view = this.view;
    for (const row of document.querySelectorAll<HTMLElement>(this.rows.row)) {
      const sessionId = row.id.startsWith(this.rows.idPrefix) ? row.id.slice(this.rows.idPrefix.length) : '';
      const providerId = view?.sessions[sessionId];
      const provider = providerId === undefined ? undefined : view?.providers[providerId];
      this.mark(row, provider);
      const other = view?.onlyCurrent === true && providerId !== undefined && providerId !== view.current;
      if (row.hasAttribute(OTHER_ATTRIBUTE) !== other) {
        row.toggleAttribute(OTHER_ATTRIBUTE, other);
      }
    }
    this.placeToggle();
  }

  private mark(row: HTMLElement, provider: { readonly name: string; readonly color: string } | undefined): void {
    let mark = row.querySelector<HTMLElement>(`:scope > .${MARK_CLASS}`);
    if (!provider) {
      mark?.remove();
      return;
    }
    const name = row.querySelector(`:scope > ${this.rows.name}`);
    if (!mark) {
      mark = document.createElement('span');
      mark.className = MARK_CLASS;
    }
    if (name && mark.nextElementSibling !== name) {
      row.insertBefore(mark, name);
    }
    if (mark.title !== provider.name) {
      mark.title = provider.name;
    }
    // The style reads back normalized: the color as given is kept beside it.
    if (mark.dataset.color !== provider.color) {
      mark.dataset.color = provider.color;
      mark.style.backgroundColor = provider.color;
    }
  }

  private placeToggle(): void {
    const view = this.view;
    const button = document.querySelector<HTMLElement>(this.filterButton);
    if (!view || !button) {
      this.toggle.remove();
      return;
    }
    if (button.nextElementSibling !== this.toggle) {
      button.after(this.toggle);
    }
    // In the filter button's own classes, so it looks like the button next to it.
    const classes = `${button.className} ${TOGGLE_CLASS}`;
    if (this.toggle.className !== classes) {
      this.toggle.className = classes;
    }
    this.toggle.title = view.filterTitle;
    this.toggle.setAttribute('aria-label', view.filterTitle);
    this.toggle.setAttribute('aria-pressed', String(view.onlyCurrent));
    const color = view.providers[view.current]?.color ?? '';
    if (this.swatch.dataset.color !== color) {
      this.swatch.dataset.color = color;
      this.swatch.style.backgroundColor = color;
    }
  }
}
