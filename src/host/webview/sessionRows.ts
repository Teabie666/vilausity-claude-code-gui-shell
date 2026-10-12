/**
 * A delete button on each row of a session list, after the page's own buttons (rename,
 * archive) and in their look: the bridge names their classes (`hints.sessionRows`). A click
 * goes to the shell, which asks first and deletes; it must not reach the row, which would
 * open the session.
 */

import type { SessionRowHints } from '../../platform/protocol';

/** Marks the shell's button, so that each row gets one. */
const BUTTON_CLASS = 'vilaus-delete-session';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** VS Code's trash codicon (as styles.css has it). */
const TRASH_PATH =
  'M14 2H10C10 0.897 9.103 0 8 0C6.897 0 6 0.897 6 2H2C1.724 2 1.5 2.224 1.5 2.5C1.5 2.776 1.724 3 2 3H2.54L3.349 12.708C3.456 13.994 4.55 15 5.84 15H10.159C11.449 15 12.543 13.993 12.65 12.708L13.459 3H13.999C14.275 3 14.499 2.776 14.499 2.5C14.499 2.224 14.275 2 13.999 2H14ZM8 1C8.551 1 9 1.449 9 2H7C7 1.449 7.449 1 8 1ZM11.655 12.625C11.591 13.396 10.934 14 10.16 14H5.841C5.067 14 4.41 13.396 4.346 12.625L3.544 3H12.458L11.656 12.625H11.655ZM7 5.5V11.5C7 11.776 6.776 12 6.5 12C6.224 12 6 11.776 6 11.5V5.5C6 5.224 6.224 5 6.5 5C6.776 5 7 5.224 7 5.5ZM10 5.5V11.5C10 11.776 9.776 12 9.5 12C9.224 12 9 11.776 9 11.5V5.5C9 5.224 9.224 5 9.5 5C9.776 5 10 5.224 10 5.5Z';

export function watchSessionRows(hints: SessionRowHints, label: string, onDelete: (sessionId: string, title: string) => void): void {
  const sessionOf = (row: HTMLElement): string | undefined => {
    const id = row.id.slice(hints.idPrefix.length);
    // Without an id the page numbers its rows instead: nothing to delete.
    return row.id.startsWith(hints.idPrefix) && SESSION_ID.test(id) ? id : undefined;
  };

  const createButton = (): HTMLElement => {
    const button = document.createElement('span');
    button.className = `${hints.buttonClass} ${BUTTON_CLASS}`;
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    button.title = label;
    button.setAttribute('aria-label', label);
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('fill', 'currentColor');
    icon.setAttribute('class', hints.iconClass);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', TRASH_PATH);
    icon.appendChild(path);
    button.appendChild(icon);
    const activate = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      const row = button.closest<HTMLElement>(hints.row);
      const sessionId = row ? sessionOf(row) : undefined;
      if (row && sessionId) {
        onDelete(sessionId, row.querySelector(hints.name)?.textContent?.trim() ?? '');
      }
    };
    button.addEventListener('click', activate);
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        activate(event);
      }
    });
    return button;
  };

  const update = (): void => {
    for (const row of document.querySelectorAll<HTMLElement>(hints.row)) {
      const actions = row.querySelector<HTMLElement>(hints.actions);
      if (actions && sessionOf(row) && !actions.querySelector(`.${BUTTON_CLASS}`)) {
        actions.appendChild(createButton());
      }
    }
  };
  new MutationObserver(update).observe(document.body, { subtree: true, childList: true });
  update();
}
