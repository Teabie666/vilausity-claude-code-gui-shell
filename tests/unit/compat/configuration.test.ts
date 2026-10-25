import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigurationService, affects, defaultsFromPackageJson } from '../../../src/compat/vscode/configuration';
import type { SettingsBackend } from '../../../src/compat/vscode/host';
import { Emitter } from '../../../src/platform/event';

function fakeBackend(initial: Record<string, unknown> = {}) {
  const changes = new Emitter<{ readonly keys: readonly string[] }>();
  const writes: [string, unknown][] = [];
  const backend: SettingsBackend & { values: Record<string, unknown> } = {
    values: { ...initial },
    onDidChange: changes.event,
    async update(key, value) {
      writes.push([key, value]);
      if (value === undefined) {
        delete backend.values[key];
      } else {
        backend.values[key] = value;
      }
      changes.fire({ keys: [key] });
    },
  };
  return { backend, writes };
}

const PACKAGE_JSON = {
  contributes: {
    configuration: {
      properties: {
        'claudeCode.useTerminal': { type: 'boolean', default: false },
        'claudeCode.environmentVariables': { type: 'array', default: [] },
        'claudeCode.noDefault': { type: 'string' },
      },
    },
  },
};

describe('defaultsFromPackageJson', () => {
  test('reads defaults from an object or an array of configuration sections and skips properties without one', () => {
    assert.deepEqual(defaultsFromPackageJson(PACKAGE_JSON), {
      'claudeCode.useTerminal': false,
      'claudeCode.environmentVariables': [],
    });
    const asArray = { contributes: { configuration: [PACKAGE_JSON.contributes.configuration, { properties: { 'x.y': { default: 1 } } }] } };
    assert.deepEqual(defaultsFromPackageJson(asArray), {
      'claudeCode.useTerminal': false,
      'claudeCode.environmentVariables': [],
      'x.y': 1,
    });
    assert.deepEqual(defaultsFromPackageJson({}), {});
  });
});

describe('ConfigurationService', () => {
  test('get prefers the user value, then the default, then the fallback argument', () => {
    const { backend } = fakeBackend({ 'claudeCode.useTerminal': true });
    const config = new ConfigurationService(backend, defaultsFromPackageJson(PACKAGE_JSON)).getConfiguration('claudeCode');
    assert.equal(config.get('useTerminal'), true);
    assert.deepEqual(config.get('environmentVariables'), []);
    assert.equal(config.get('missing'), undefined);
    assert.equal(config.get('missing', 'fallback'), 'fallback');
  });

  test('exposes the section values as properties, merged over the defaults', () => {
    const { backend } = fakeBackend({ 'claudeCode.useTerminal': true });
    const config = new ConfigurationService(backend, defaultsFromPackageJson(PACKAGE_JSON)).getConfiguration('claudeCode');
    const record = config as unknown as Record<string, unknown>;
    assert.equal(record.useTerminal, true);
    assert.deepEqual(record.environmentVariables, []);
    assert.deepEqual(Object.keys(record).sort(), ['environmentVariables', 'useTerminal']);
  });

  test("vilaus's own defaults win over the package's, for settings it declares", () => {
    const { backend } = fakeBackend({});
    const service = new ConfigurationService(backend, { 'claudeCode.hideOnboarding': false });
    assert.equal(service.getConfiguration('claudeCode').get('hideOnboarding'), true);
    const { backend: other } = fakeBackend({ 'claudeCode.hideOnboarding': false });
    assert.equal(
      new ConfigurationService(other, { 'claudeCode.hideOnboarding': false }).getConfiguration('claudeCode').get('hideOnboarding'),
      false,
      'the user setting wins',
    );
  });

  test('reads nested keys and merges object values shallowly over the default', () => {
    const { backend } = fakeBackend({ 'files.exclude': { '**/dist': true } });
    const service = new ConfigurationService(backend, {});
    const exclude = service.getConfiguration('files').get<Record<string, boolean>>('exclude')!;
    assert.equal(exclude['**/dist'], true);
    assert.equal(exclude['**/.git'], true, 'core default kept');
    assert.equal(service.getConfiguration().get('files.autoSave'), 'off');
  });

  test('has and inspect report user and default values; inspect returns copies', () => {
    const { backend } = fakeBackend({ 'claudeCode.environmentVariables': [{ name: 'A', value: '1' }] });
    const config = new ConfigurationService(backend, defaultsFromPackageJson(PACKAGE_JSON)).getConfiguration('claudeCode');
    assert.equal(config.has('useTerminal'), true);
    assert.equal(config.has('nope'), false);
    const inspected = config.inspect<{ name: string; value: string }[]>('environmentVariables')!;
    assert.equal(inspected.key, 'claudeCode.environmentVariables');
    assert.deepEqual(inspected.defaultValue, []);
    assert.deepEqual(inspected.globalValue, [{ name: 'A', value: '1' }]);
    inspected.globalValue!.push({ name: 'B', value: '2' });
    assert.equal(config.get<unknown[]>('environmentVariables')!.length, 1, 'internal state untouched');
  });

  test('get returns copies, so callers cannot mutate settings', () => {
    const { backend } = fakeBackend({ 'claudeCode.environmentVariables': [{ name: 'A', value: '1' }] });
    const config = new ConfigurationService(backend, {}).getConfiguration('claudeCode');
    config.get<unknown[]>('environmentVariables')!.push('x');
    assert.equal(config.get<unknown[]>('environmentVariables')!.length, 1);
  });

  test('update writes the full dotted key; helper methods are not enumerable', async () => {
    const { backend, writes } = fakeBackend();
    const config = new ConfigurationService(backend, {}).getConfiguration('claudeCode');
    await config.update('preferredLocation', 'sidebar');
    assert.deepEqual(writes, [['claudeCode.preferredLocation', 'sidebar']]);
    assert.equal(Object.keys(config).includes('get'), false);
    assert.equal(typeof config.get, 'function');
  });

  test('onDidChangeConfiguration reports which sections a change affects', async () => {
    const { backend } = fakeBackend();
    const service = new ConfigurationService(backend, {});
    const events: [boolean, boolean, boolean, boolean][] = [];
    service.onDidChangeConfiguration((event) => {
      events.push([
        event.affectsConfiguration('claudeCode'),
        event.affectsConfiguration('claudeCode.useTerminal'),
        event.affectsConfiguration('claudeCode.useTerminal.deeper'),
        event.affectsConfiguration('editor'),
      ]);
    });
    await service.getConfiguration('claudeCode').update('useTerminal', true);
    assert.deepEqual(events, [[true, true, true, false]]);
    assert.equal(service.getConfiguration('claudeCode').get('useTerminal'), true);
  });
});

describe('affects', () => {
  test('matches the key itself, its parents and its children, but not siblings', () => {
    assert.equal(affects(['a.b'], 'a'), true);
    assert.equal(affects(['a.b'], 'a.b'), true);
    assert.equal(affects(['a.b'], 'a.b.c'), true);
    assert.equal(affects(['a.b'], 'a.bc'), false);
    assert.equal(affects(['a.b'], 'x'), false);
  });
});
