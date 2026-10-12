/**
 * The session list's filters as one drop-down: the status filter's button (its menu filters by
 * status and by open tabs) shows the "Active · N" count of the page's own toggle, which the
 * bridge's styles hide, and, while sessions wait for the user, "Needs input · N" (the count
 * comes from the bridge). The button shows them through `data-vilaus-*` attributes, so its
 * content stays as React made it.
 */

import type { StatusFilterHints } from '../../platform/protocol';

export class StatusFilter {
  private needsInput = 0;
  /**
   * When the hidden toggle was last turned off. Hidden, it must stay off (a filter left on from
   * before would hold the list with no way out); the page re-renders a moment after a click.
   */
  private turnedOffAt = 0;

  constructor(
    private readonly hints: StatusFilterHints,
    /** "Needs input · {0}" in the display language. */
    private readonly needsInputTemplate: string,
  ) {
    new MutationObserver(() => this.update()).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-pressed'],
    });
    this.update();
  }

  setNeedsInput(count: number): void {
    this.needsInput = count;
    this.update();
  }

  private update(): void {
    const button = document.querySelector<HTMLElement>(this.hints.menuButton);
    const toggle = document.querySelector<HTMLElement>(this.hints.activeToggle);
    if (!button || !toggle) {
      return;
    }
    if (toggle.getAttribute('aria-pressed') === 'true' && Date.now() - this.turnedOffAt > 1000) {
      this.turnedOffAt = Date.now();
      toggle.click();
    }
    setAttribute(button, 'data-vilaus-label', toggle.textContent?.trim() || undefined);
    setAttribute(
      button,
      'data-vilaus-needs-input',
      this.needsInput > 0 ? this.needsInputTemplate.replace('{0}', String(this.needsInput)) : undefined,
    );
  }
}

/** Only on change: setting an attribute is a mutation the observer above may see. */
function setAttribute(element: HTMLElement, name: string, value: string | undefined): void {
  if (value === undefined) {
    if (element.hasAttribute(name)) {
      element.removeAttribute(name);
    }
  } else if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}
