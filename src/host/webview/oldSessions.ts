/**
 * A session list's rows of the sessions not active for longer than the setting shows
 * (`vilaus.sessions.showWithinDays`): the bridge names them (the `oldSessions` control), they
 * get `data-vilaus-old-session`, which the bridge's styles hide. Nothing is deleted, and the
 * search still finds them.
 */

import type { SessionRowHints } from '../../platform/protocol';

const OLD_ATTRIBUTE = 'data-vilaus-old-session';

export class OldSessions {
  private ids = new Set<string>();

  constructor(private readonly rows: SessionRowHints) {
    new MutationObserver(() => this.update()).observe(document.body, { subtree: true, childList: true });
  }

  set(ids: readonly string[]): void {
    this.ids = new Set(ids);
    this.update();
  }

  private update(): void {
    for (const row of document.querySelectorAll<HTMLElement>(this.rows.row)) {
      const sessionId = row.id.startsWith(this.rows.idPrefix) ? row.id.slice(this.rows.idPrefix.length) : '';
      const old = this.ids.has(sessionId);
      if (row.hasAttribute(OLD_ATTRIBUTE) !== old) {
        row.toggleAttribute(OLD_ATTRIBUTE, old);
      }
    }
  }
}
