import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { readContributions } from '../../../src/host/exthost/contributions';

describe('readContributions', () => {
  test('reads command titles and menu items, skipping malformed entries', () => {
    const result = readContributions({
      contributes: {
        commands: [
          { command: 'ext.rename', title: 'Ext: Rename', category: 'Ext' },
          { command: 'ext.plain', title: 'Plain' },
          { command: 'ext.noTitle' },
          'not an object',
          null,
        ],
        menus: {
          'webview/context': [
            { command: 'ext.rename', when: "webviewId == 'panel'", group: 'navigation@1' },
            { submenu: 'ext.submenu', group: 'navigation' },
            { command: 42 },
          ],
          commandPalette: [{ command: 'ext.rename', when: 'false' }],
          notAnArray: 'oops',
        },
      },
    });
    assert.deepEqual(result.commands, [
      { command: 'ext.rename', title: 'Ext: Rename', category: 'Ext' },
      { command: 'ext.plain', title: 'Plain', category: undefined },
    ]);
    assert.deepEqual(result.menus['webview/context'], [{ command: 'ext.rename', when: "webviewId == 'panel'", group: 'navigation@1' }]);
    assert.deepEqual(result.menus.commandPalette, [{ command: 'ext.rename', when: 'false', group: undefined }]);
    assert.deepEqual(result.menus.notAnArray, []);
  });

  test('a manifest without usable contributes has no commands, menus or settings', () => {
    const empty = { commands: [], menus: {}, configuration: [] };
    assert.deepEqual(readContributions({}), empty);
    assert.deepEqual(readContributions({ contributes: [] }), empty);
    assert.deepEqual(readContributions({ contributes: { commands: {}, menus: [] } }), empty);
  });

  test('reads settings from one configuration or a list, titled by the configuration or the extension', () => {
    const one = readContributions({
      displayName: 'Ext',
      contributes: { configuration: { properties: { 'ext.a': { type: 'boolean', default: true }, 'ext.bad': 3 } } },
    });
    assert.deepEqual(one.configuration, [{ key: 'ext.a', schema: { type: 'boolean', default: true }, section: 'Ext' }]);
    const many = readContributions({
      contributes: {
        configuration: [
          { title: 'First', properties: { 'ext.b': { type: 'string' } } },
          { title: 'Second', properties: { 'ext.c': { type: 'number', minimum: 1 } } },
          'not an object',
        ],
      },
    });
    assert.deepEqual(
      many.configuration.map((setting) => [setting.key, setting.section]),
      [
        ['ext.b', 'First'],
        ['ext.c', 'Second'],
      ],
    );
  });
});
