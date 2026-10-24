import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { versionInfoText } from '../../../src/features/about/versionInfo';

const runtime = { electron: '44.0.0', chromium: '140.0.7339.0', node: '22.20.0', os: 'Windows_NT x64 10.0.26200' };

describe('versionInfoText', () => {
  test('one English line per part, the app and the extension first', () => {
    assert.equal(
      versionInfoText({ app: '0.9.4', extension: '2.1.310', ...runtime }),
      [
        'Vilausity: 0.9.4',
        'Claude Code extension: 2.1.310',
        'Electron: 44.0.0',
        'Chromium: 140.0.7339.0',
        'Node.js: 22.20.0',
        'OS: Windows_NT x64 10.0.26200',
      ].join('\n'),
    );
  });

  test('says so when there is no extension', () => {
    assert.ok(versionInfoText({ app: '0.9.4', extension: undefined, ...runtime }).includes('Claude Code extension: not found'));
  });
});
