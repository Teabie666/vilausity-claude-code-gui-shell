import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveKeybindings } from '../../../src/core/keybindings';
import { changeKeybinding, removeKeybinding, resetKeybindings } from '../../../src/features/keybindings/edits';
import { editKeybindingsText } from '../../../src/host/main/keybindingsStore';
import { parseKeybindingEntries } from '../../../src/platform/keybindings';
import { parse } from 'jsonc-parser';

const DEFAULTS = [
  { key: 'ctrl+b', command: 'sessions.toggleSidebar' },
  { key: 'ctrl+w', command: 'contentPane.closeEditor', when: 'contentPaneFocus' },
];

describe('keybinding edits', () => {
  test('changing a default adds the new keys and removes the default; reset takes both out', () => {
    const rule = resolveKeybindings(DEFAULTS, [])[1]!;
    const edit = changeKeybinding(rule, rule.command, 'ctrl+alt+w');
    assert.deepEqual(edit, {
      remove: [],
      add: [
        { key: 'ctrl+alt+w', command: 'contentPane.closeEditor', when: 'contentPaneFocus' },
        { key: 'ctrl+w', command: '-contentPane.closeEditor', when: 'contentPaneFocus' },
      ],
    });
    const after = resolveKeybindings(DEFAULTS, edit.add);
    assert.deepEqual(
      after.map((resolved) => [resolved.key, resolved.command, resolved.source]),
      [
        ['ctrl+b', 'sessions.toggleSidebar', 'default'],
        ['ctrl+alt+w', 'contentPane.closeEditor', 'user'],
      ],
    );
    const unrelated = { key: 'alt+x', command: 'other' };
    assert.deepEqual(resetKeybindings('contentPane.closeEditor', [...edit.add, unrelated]), { remove: edit.add, add: [] });
  });

  test("changing the user's own keybinding edits its entry; removing it deletes the entry", () => {
    const entry = { key: 'ctrl+alt+b', command: 'sessions.toggleSidebar', when: 'x', args: 1 };
    const rule = resolveKeybindings([], [entry])[0]!;
    assert.deepEqual(changeKeybinding(rule, rule.command, 'ctrl+shift+b'), { remove: [entry], add: [{ ...entry, key: 'ctrl+shift+b' }] });
    assert.deepEqual(removeKeybinding(rule), { remove: [entry], add: [] });
  });

  test('removing a default writes a removal; a command without keys gets its first', () => {
    const rule = resolveKeybindings(DEFAULTS, [])[0]!;
    assert.deepEqual(removeKeybinding(rule), { remove: [], add: [{ key: 'ctrl+b', command: '-sessions.toggleSidebar' }] });
    assert.deepEqual(changeKeybinding(undefined, 'settings.openJson', 'ctrl+alt+,'), {
      remove: [],
      add: [{ key: 'ctrl+alt+,', command: 'settings.openJson' }],
    });
  });
});

describe('keybindings.json text', () => {
  test('appends and removes entries; comments and the other entries stay', () => {
    const text = [
      '// mine',
      '[',
      '  { "key": "ctrl+alt+b", "command": "sessions.toggleSidebar" }, // the sidebar',
      '  { "key": "ctrl+b", "command": "-sessions.toggleSidebar" },',
      '  { "key": "alt+x", "command": "other" }',
      ']',
      '',
    ].join('\n');
    const edited = editKeybindingsText(
      text,
      [{ key: 'ctrl+alt+b', command: 'sessions.toggleSidebar' }, { key: 'ctrl+b', command: '-sessions.toggleSidebar' }],
      [{ key: 'ctrl+shift+b', command: 'sessions.toggleSidebar', when: 'x' }],
    );
    assert.match(edited, /^\/\/ mine/);
    assert.deepEqual(parseKeybindingEntries(parse(edited)), [
      { key: 'alt+x', command: 'other' },
      { key: 'ctrl+shift+b', command: 'sessions.toggleSidebar', when: 'x' },
    ]);
  });

  test('an empty or broken file starts over as an array; a missing entry is no error', () => {
    for (const text of ['', '{}', '// only a comment\n']) {
      const edited = editKeybindingsText(text, [{ key: 'ctrl+q', command: 'gone' }], [{ key: 'ctrl+alt+q', command: 'a' }]);
      assert.deepEqual(parseKeybindingEntries(parse(edited)), [{ key: 'ctrl+alt+q', command: 'a' }], JSON.stringify(text));
    }
  });

  test('of two equal entries, one goes per removal', () => {
    const text = '[{"key":"ctrl+q","command":"a"},{"key":"ctrl+q","command":"a"}]';
    assert.equal(parseKeybindingEntries(parse(editKeybindingsText(text, [{ key: 'ctrl+q', command: 'a' }], []))).length, 1);
  });
});
