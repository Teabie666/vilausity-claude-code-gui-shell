import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { StorageBackend } from '../../../src/compat/vscode/host';
import { Memento } from '../../../src/compat/vscode/memento';
import { Emitter } from '../../../src/platform/event';
import type { StorageScope } from '../../../src/platform/protocol';

function setup(initial: Record<StorageScope, Record<string, unknown>> = { global: {}, workspace: {} }) {
  const changes = new Emitter<{ scope: StorageScope; key: string; value: unknown }>();
  const writes: { scope: StorageScope; key: string; value: unknown }[] = [];
  const backend: StorageBackend = {
    initial: (scope) => initial[scope],
    set: (scope, key, value) => writes.push({ scope, key, value }),
    onDidChange: changes.event,
  };
  return { backend, changes, writes };
}

describe('Memento', () => {
  test('starts from the stored values and writes updates through as JSON', async () => {
    const { backend, writes } = setup({ global: { a: 1 }, workspace: {} });
    const memento = new Memento('global', backend);
    assert.equal(memento.get('a'), 1);
    assert.equal(memento.get('missing', 'fallback'), 'fallback');

    await memento.update('b', { when: new Date(0), skip: () => 1 });
    assert.deepEqual(memento.get('b'), { when: '1970-01-01T00:00:00.000Z' });
    assert.deepEqual(writes, [{ scope: 'global', key: 'b', value: { when: '1970-01-01T00:00:00.000Z' } }]);

    await memento.update('a', undefined);
    assert.deepEqual(memento.keys(), ['b']);
  });

  test('takes changes made elsewhere for its own scope, without writing them back', () => {
    const { backend, changes, writes } = setup();
    const global = new Memento('global', backend);
    const workspace = new Memento('workspace', backend);

    changes.fire({ scope: 'global', key: 'shared', value: [1, 2] });
    assert.deepEqual(global.get('shared'), [1, 2]);
    assert.equal(workspace.get('shared'), undefined);

    changes.fire({ scope: 'global', key: 'shared', value: undefined });
    assert.deepEqual(global.keys(), []);
    assert.deepEqual(writes, []);
  });
});
