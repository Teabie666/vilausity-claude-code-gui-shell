/**
 * The account's usage bars say when they reset to the minute ("Resets 15:42", "Resets
 * tomorrow 09:00") instead of the page's own "Resets in 3h". The bridge reads the exact times
 * from what the extension sends the page and passes them on by the bars' labels; the page's
 * text stays where React put it, hidden, and the shell's shows through `data-vilaus-reset`
 * (the bridge's styles).
 */

import type { UsageBarHints } from '../../platform/protocol';

const ATTRIBUTE = 'data-vilaus-reset';
const DAY = 86_400_000;

/**
 * `at` as a reset time: the time alone today, then "tomorrow", a weekday within the week, and
 * a date after that; in `locale`, 24-hour.
 */
export function formatResetTime(at: number, now: number, locale: string): string {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  const startOfDay = (value: number): number => {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days <= 0) {
    return time;
  }
  if (days === 1) {
    return `${new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(1, 'day')} ${time}`;
  }
  const day = new Intl.DateTimeFormat(locale, days < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' }).format(at);
  return `${day} ${time}`;
}

export class UsageResets {
  private resets = new Map<string, number>();
  private scheduled = false;

  constructor(
    private readonly hints: UsageBarHints,
    /** "Resets {0}" in the display language. */
    private readonly template: string,
    private readonly locale: string,
    /** A label's text as the page wrote it (the translation may have changed what shows). */
    private readonly originalText: (element: Element) => string,
  ) {
    // Once a frame at most: a conversation's text changes all the time while Claude writes.
    new MutationObserver(() => this.schedule()).observe(document.body, { subtree: true, childList: true, characterData: true });
    // A time that has passed goes back to the page's own text ("soon").
    setInterval(() => this.schedule(), 60_000);
  }

  set(resets: Readonly<Record<string, number>>): void {
    this.resets = new Map(Object.entries(resets));
    this.update();
  }

  private schedule(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.update();
    });
  }

  private update(): void {
    const now = Date.now();
    for (const bar of document.querySelectorAll(this.hints.bar)) {
      const reset = bar.querySelector<HTMLElement>(this.hints.reset);
      const label = bar.querySelector(this.hints.label);
      if (!reset || !label) {
        continue;
      }
      const at = this.resets.get(this.originalText(label).trim());
      const text = at !== undefined && at > now ? this.template.replace('{0}', formatResetTime(at, now, this.locale)) : undefined;
      if (text === undefined) {
        reset.removeAttribute(ATTRIBUTE);
      } else if (reset.getAttribute(ATTRIBUTE) !== text) {
        if (!reset.hasAttribute(ATTRIBUTE)) {
          // The page's size, read while its own text still shows; the styles hide that text.
          reset.style.setProperty('--vilaus-reset-size', getComputedStyle(reset).fontSize);
        }
        reset.setAttribute(ATTRIBUTE, text);
      }
    }
  }
}
