import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CommandService } from '../../../src/core/commands';
import { ContextKeyService } from '../../../src/core/contextKeys';
import { KeybindingService, resolveKeybindings, type KeybindingRule } from '../../../src/core/keybindings';
import type { ILogger } from '../../../src/platform/log';

const logger: ILogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as unknown as ILogger;

const DEFAULTS: KeybindingRule[] = [
  { key: 'ctrl+b', command: 'sessions.toggleSidebar' },
  { key: 'ctrl+tab', command: 'conversations.next' },
  { key: 'ctrl+pagedown', command: 'conversations.next' },
  { key: 'ctrl+w', command: 'contentPane.closeEditor', when: 'contentPaneFocus' },
  { key: 'ctrl+f4', command: 'contentPane.closeEditor', when: 'contentPaneFocus' },
];

describe('resolveKeybindings', () => {
  test('without keybindings.json: the defaults', () => {
    assert.deepEqual(
      resolveKeybindings(DEFAULTS, []).map((rule) => [rule.key, rule.command, rule.source]),
      DEFAULTS.map((rule) => [rule.key, rule.command, 'default']),
    );
  });

  test('a removal takes out the defaults of its command with its key and when; the entries come last', () => {
    const resolved = resolveKeybindings(DEFAULTS, [
      { key: 'ctrl+alt+b', command: 'sessions.toggleSidebar' },
      { key: 'Ctrl+B', command: '-sessions.toggleSidebar' },
      { key: 'ctrl+tab', command: '-conversations.next' },
      { key: 'ctrl+w', command: '-contentPane.closeEditor', when: 'somethingElse' },
      { key: '', command: '-nothing.bound' },
      { key: 'ctrl+1', command: 'conversations.goTo1', args: 0 },
    ]);
    assert.deepEqual(
      resolved.map((rule) => [rule.key, rule.command, rule.source, rule.args]),
      [
        ['ctrl+pagedown', 'conversations.next', 'default', undefined],
        ['ctrl+w', 'contentPane.closeEditor', 'default', undefined],
        ['ctrl+f4', 'contentPane.closeEditor', 'default', undefined],
        ['ctrl+alt+b', 'sessions.toggleSidebar', 'user', undefined],
        ['ctrl+1', 'conversations.goTo1', 'user', [0]],
      ],
    );
    assert.deepEqual(resolved[3]!.entry, { key: 'ctrl+alt+b', command: 'sessions.toggleSidebar' });
  });

  test('a removal without a key takes out every default of its command; with when, only those', () => {
    assert.deepEqual(
      resolveKeybindings(DEFAULTS, [{ key: '', command: '-conversations.next' }]).map((rule) => rule.key),
      ['ctrl+b', 'ctrl+w', 'ctrl+f4'],
    );
    assert.deepEqual(
      resolveKeybindings(DEFAULTS, [{ key: '', command: '-contentPane.closeEditor', when: 'contentPaneFocus' }]).map((rule) => rule.key),
      ['ctrl+b', 'ctrl+tab', 'ctrl+pagedown'],
    );
  });
});

describe('KeybindingService', () => {
  const setup = () => {
    const contextKeys = new ContextKeyService();
    const commands = new CommandService(contextKeys, logger);
    const synced: string[][] = [];
    const keybindings = new KeybindingService(commands, contextKeys, (chords) => synced.push(chords), logger);
    const ran: string[] = [];
    for (const id of ['a', 'b']) {
      commands.register(id, (...args) => void ran.push([id, ...args].join(':')));
    }
    return { keybindings, synced, ran, contextKeys };
  };

  test('keybindings.json wins over the defaults; labels follow it', async () => {
    const { keybindings, ran } = setup();
    keybindings.register({ key: 'ctrl+b', command: 'a' });
    keybindings.register({ key: 'ctrl+e', command: 'a' });
    assert.equal(keybindings.labelFor('a'), 'Ctrl+B');
    assert.equal(keybindings.tooltip('Toggle', 'a'), 'Toggle (Ctrl+B)');
    keybindings.setUserEntries([{ key: 'ctrl+b', command: 'b', args: 7 }, { key: 'alt+a', command: 'a' }]);
    assert.equal(await keybindings.dispatch('ctrl+b'), true);
    assert.deepEqual(ran, ['b:7']);
    assert.equal(keybindings.labelFor('a'), 'Alt+A');
    assert.equal(keybindings.tooltip('Other', 'nothing'), 'Other');
  });

  test('a bad when clause in keybindings.json never applies', async () => {
    const { keybindings, ran } = setup();
    keybindings.register({ key: 'ctrl+b', command: 'a' });
    keybindings.setUserEntries([{ key: 'ctrl+b', command: 'b', when: 'a &&' }]);
    assert.equal(await keybindings.dispatch('ctrl+b'), true);
    assert.deepEqual(ran, ['a']);
  });

  test('main hears the chords once per burst, and none while one is recorded', async () => {
    const { keybindings, synced } = setup();
    keybindings.register({ key: 'ctrl+b', command: 'a' });
    keybindings.register({ key: 'ctrl+e', command: 'b' });
    await Promise.resolve();
    assert.deepEqual(synced, [['ctrl+b', 'ctrl+e']]);
    const paused = keybindings.pauseInterception();
    assert.deepEqual(synced.at(-1), []);
    keybindings.setUserEntries([{ key: 'alt+x', command: 'a' }]);
    await Promise.resolve();
    assert.deepEqual(synced.at(-1), []);
    paused.dispose();
    paused.dispose();
    assert.deepEqual(synced.at(-1), ['ctrl+b', 'ctrl+e', 'alt+x']);
  });
});
