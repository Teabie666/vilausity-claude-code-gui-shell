import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatChord,
  isCommandChord,
  normalizeChord,
  parseKeybindingEntries,
  sameKeybindingEntry,
} from '../../../src/platform/keybindings';

describe('chords', () => {
  test('normalizes modifiers into one order; VS Code names the Windows key win', () => {
    assert.equal(normalizeChord('Shift+Ctrl+P'), 'ctrl+shift+p');
    assert.equal(normalizeChord('win+e'), 'meta+e');
    assert.equal(normalizeChord('cmd+alt+k'), 'alt+meta+k');
  });

  test('labels keys as VS Code does', () => {
    assert.equal(formatChord('ctrl+pagedown'), 'Ctrl+PageDown');
    assert.equal(formatChord('alt+left'), 'Alt+LeftArrow');
    assert.equal(formatChord('ctrl+numpad_add'), 'Ctrl+NumPad_Add');
    assert.equal(formatChord('meta+e'), 'Win+E');
    assert.equal(formatChord('ctrl+\\'), 'Ctrl+\\');
  });

  test('a keybinding needs Ctrl, Alt or the Windows key, unless it is a function key', () => {
    for (const chord of ['ctrl+b', 'alt+left', 'meta+e', 'f1', 'shift+f12', 'ctrl+shift+p']) {
      assert.equal(isCommandChord(chord), true, chord);
    }
    for (const chord of ['a', 'shift+a', 'enter', 'escape', 'shift+tab', 'space']) {
      assert.equal(isCommandChord(chord), false, chord);
    }
  });
});

describe('keybindings.json entries', () => {
  test('keeps the entries that can take effect', () => {
    const entries = parseKeybindingEntries([
      { key: 'ctrl+alt+b', command: 'sessions.toggleSidebar' },
      { key: 'ctrl+b', command: '-sessions.toggleSidebar', when: '' },
      { key: '', command: '-quickOpen.show' },
      { key: 'ctrl+k ctrl+s', command: 'keybindings.open' },
      { key: 'ctrl+1', command: 'conversations.goTo1', when: 'conversations.multiple', args: { x: 1 } },
      { key: '', command: 'settings.open' },
      { key: 'ctrl+q', command: '-' },
      { command: 'settings.open' },
      'ctrl+q',
      null,
      [1],
    ]);
    assert.deepEqual(entries, [
      { key: 'ctrl+alt+b', command: 'sessions.toggleSidebar' },
      { key: 'ctrl+b', command: '-sessions.toggleSidebar' },
      { key: '', command: '-quickOpen.show' },
      { key: 'ctrl+1', command: 'conversations.goTo1', when: 'conversations.multiple', args: { x: 1 } },
    ]);
    assert.deepEqual(parseKeybindingEntries({ key: 'ctrl+b' }), []);
  });

  test('the same entry: key, command, when and args as written', () => {
    const entry = { key: 'ctrl+b', command: 'a', when: 'x', args: [1] };
    assert.equal(sameKeybindingEntry(entry, { ...entry }), true);
    assert.equal(sameKeybindingEntry(entry, { ...entry, key: 'Ctrl+B' }), false);
    assert.equal(sameKeybindingEntry(entry, { ...entry, args: [2] }), false);
    assert.equal(sameKeybindingEntry({ key: 'ctrl+b', command: 'a' }, { key: 'ctrl+b', command: 'a', when: '' }), true);
  });
});
