import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { versionInfoText, type VersionInfoLabels } from '../../../src/features/about/versionInfo';

const labels: VersionInfoLabels = {
  app: 'Vilausity',
  extension: 'Claude Code extension',
  electron: 'Electron',
  chromium: 'Chromium',
  node: 'Node.js',
  notInstalled: 'Not installed',
};

describe('versionInfoText', () => {
  test('one label and value per line, in the About section order', () => {
    assert.equal(
      versionInfoText({ app: '0.9.4', extension: '2.1.310', electron: '44.0.0', chromium: '140.0.7339.0', node: '22.20.0' }, labels),
      ['Vilausity 0.9.4', 'Claude Code extension 2.1.310', 'Electron 44.0.0', 'Chromium 140.0.7339.0', 'Node.js 22.20.0'].join('\n'),
    );
  });

  test('says so when there is no extension', () => {
    const text = versionInfoText(
      { app: '0.9.4', extension: undefined, electron: '44.0.0', chromium: '140.0.7339.0', node: '22.20.0' },
      labels,
    );
    assert.ok(text.includes('Claude Code extension Not installed'));
  });
});
