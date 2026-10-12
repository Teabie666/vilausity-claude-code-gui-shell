/**
 * The settings editor in a panel over the middle of the window (not a separate window, not a
 * content pane tab): opened from the gear, Ctrl+, or the command; Escape, the close button or
 * a click beside it closes it. Actions that open something else (settings.json, the API
 * providers) close it first.
 */

import type { Dialogs } from '../../core/dialogs';
import { t } from './messages';
import { SettingsEditorPane, type SettingsEditorContext } from './settingsEditor';

export class SettingsDialog {
  private open: { pane: SettingsEditorPane; close: () => void } | undefined;

  constructor(
    private readonly dialogs: Dialogs,
    private readonly context: SettingsEditorContext,
  ) {}

  get isOpen(): boolean {
    return this.open !== undefined;
  }

  /** Opens the panel (or keeps the open one), with `query` in its search box if given, or at `section`. */
  show(query?: string, section?: string): void {
    if (!this.open) {
      this.open = this.create();
    }
    if (query !== undefined) {
      this.open.pane.setQuery(query);
    }
    if (section !== undefined) {
      this.open.pane.setQuery('');
      this.open.pane.revealSection(section);
    }
    this.open.pane.focus();
  }

  close(): void {
    this.open?.close();
  }

  private create(): { pane: SettingsEditorPane; close: () => void } {
    let pane: SettingsEditorPane | undefined;
    const { box, finish } = this.dialogs.openOverlay<void>(() => {
      pane?.dispose();
      this.open = undefined;
    }, undefined);
    box.parentElement?.classList.add('overlay-backdrop-centered');
    box.classList.add('settings-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', t('settingsTitle'));

    const header = document.createElement('div');
    header.className = 'settings-dialog-header';
    const title = document.createElement('span');
    title.className = 'settings-dialog-title';
    title.textContent = t('settingsTitle');
    const close = document.createElement('button');
    close.className = 'icon-button icon-close';
    close.title = t('closeSettings');
    close.setAttribute('aria-label', t('closeSettings'));
    close.addEventListener('click', () => finish());
    header.append(title, close);
    const body = document.createElement('div');
    body.className = 'settings-dialog-body';
    box.append(header, body);

    pane = new SettingsEditorPane(body, this.context);
    return { pane, close: () => finish() };
  }
}
