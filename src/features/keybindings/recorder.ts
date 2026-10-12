/**
 * Records a new keybinding, after VS Code's "define keybinding" widget: a small panel over
 * the window shows the keys as they are pressed; Enter takes them, Escape cancels. Main
 * stops taking chords meanwhile (otherwise Ctrl+P would open the search instead).
 */

import type { Dialogs } from '../../core/dialogs';
import type { KeybindingService } from '../../core/keybindings';
import { chordFromInput, formatChord, isCommandChord } from '../../platform/keybindings';
import { t } from './messages';

export interface RecordOptions {
  /** The command's title. */
  readonly title: string;
  /** Its keybinding now (it is not a conflict). */
  readonly current?: string;
  /** What else the keys run now, by title. */
  readonly conflicts: (chord: string) => string[];
}

/** The keys as `<kbd>` chips: `Ctrl` + `Shift` + `P`. */
export function renderChord(chord: string): HTMLElement {
  const keys = document.createElement('span');
  keys.className = 'keybinding-keys';
  formatChord(chord)
    .split('+')
    .forEach((part, index) => {
      if (index > 0) {
        keys.append('+');
      }
      const key = document.createElement('kbd');
      key.textContent = part;
      keys.appendChild(key);
    });
  return keys;
}

/** Resolves to the normalized chord, or undefined when cancelled. */
export function recordKeybinding(dialogs: Dialogs, keybindings: KeybindingService, options: RecordOptions): Promise<string | undefined> {
  return new Promise((resolve) => {
    const paused = keybindings.pauseInterception();
    const { box, finish } = dialogs.openOverlay<string | undefined>((value) => {
      paused.dispose();
      resolve(value);
    }, undefined);
    // Centered over the settings, which stay as they are (no second dimming).
    box.parentElement?.classList.add('keybinding-recorder-backdrop');
    box.classList.add('keybinding-recorder');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', t('recordTitle', options.title));

    const title = document.createElement('div');
    title.className = 'keybinding-recorder-title';
    title.textContent = t('recordTitle', options.title);
    const hint = document.createElement('div');
    hint.className = 'keybinding-recorder-hint';
    hint.textContent = t('recordHint');
    const field = document.createElement('div');
    field.className = 'keybinding-recorder-field';
    field.tabIndex = 0;
    field.setAttribute('role', 'textbox');
    field.setAttribute('aria-live', 'polite');
    const message = document.createElement('div');
    message.className = 'keybinding-recorder-message';
    box.append(title, hint, field, message);

    let chord: string | undefined;
    const show = (): void => {
      field.replaceChildren(chord ? renderChord(chord) : t('recordEmpty'));
      field.classList.toggle('empty', !chord);
      let problem = '';
      let warning = '';
      if (chord && !isCommandChord(chord)) {
        problem = t('recordNeedsModifier');
      } else if (chord && chord === options.current) {
        warning = t('recordUnchanged');
      } else if (chord) {
        const others = options.conflicts(chord);
        warning = others.length > 0 ? t('recordConflicts', others.join(', ')) : '';
      }
      message.textContent = problem || warning;
      message.classList.toggle('error', problem !== '');
      field.classList.toggle('invalid', problem !== '');
    };
    field.addEventListener('keydown', (event) => {
      // Escape goes on to the overlay, which cancels.
      if (event.key === 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const pressed = chordFromInput({
        code: event.code,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        meta: event.metaKey,
      });
      if (pressed === 'enter') {
        if (chord && isCommandChord(chord)) {
          finish(chord);
        }
        return;
      }
      if (pressed) {
        chord = pressed;
        show();
      }
    });
    // Keys go to the field wherever the pointer clicked.
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      field.focus();
    });
    show();
    field.focus();
  });
}
