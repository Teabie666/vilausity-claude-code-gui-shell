import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { attachmentsFolder, freeName, placeInWorkspace } from '../../../src/host/main/attachments';
import { NullLogger } from '../../../src/platform/log';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vilaus-attachments-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('attachmentsFolder', () => {
  const workspace = path.join(root, 'ws');

  test('is the folder named, inside the workspace, also a nested one', () => {
    assert.equal(attachmentsFolder(workspace, 'attachments'), path.join(workspace, 'attachments'));
    assert.equal(attachmentsFolder(workspace, ' docs/dropped '), path.join(workspace, 'docs', 'dropped'));
  });

  test('falls back to attachments for a folder outside the workspace, the workspace itself, or none', () => {
    const fallback = path.join(workspace, 'attachments');
    assert.equal(attachmentsFolder(workspace, '../elsewhere'), fallback);
    assert.equal(attachmentsFolder(workspace, path.join(root, 'other')), fallback);
    assert.equal(attachmentsFolder(workspace, '.'), fallback);
    assert.equal(attachmentsFolder(workspace, ''), fallback);
  });
});

describe('freeName', () => {
  test('keeps a free name, and numbers a taken one before the extension', () => {
    const taken = new Set(['notes.txt', 'notes (1).txt', 'folder', 'archive.tar.gz']);
    const isTaken = (name: string): boolean => taken.has(name);
    assert.equal(freeName('other.txt', false, isTaken), 'other.txt');
    assert.equal(freeName('notes.txt', false, isTaken), 'notes (2).txt');
    assert.equal(freeName('archive.tar.gz', false, isTaken), 'archive.tar (1).gz');
  });

  test('numbers a folder after its whole name, dots and all', () => {
    const isTaken = (name: string): boolean => name === 'my.folder';
    assert.equal(freeName('my.folder', true, isTaken), 'my.folder (1)');
  });
});

describe('placeInWorkspace', () => {
  const workspace = path.join(root, 'place', 'ws');
  const outside = path.join(root, 'place', 'outside');
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'folder', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'a');
  fs.writeFileSync(path.join(outside, 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(outside, 'folder', 'deeper', 'inner.txt'), 'inner');

  test('keeps what is in the workspace, copies the rest into the folder (made when missing), folders whole', async () => {
    const result = await placeInWorkspace(
      [path.join(workspace, 'src', 'a.ts'), path.join(outside, 'notes.txt'), path.join(outside, 'folder')],
      workspace,
      'attachments',
      NullLogger,
    );
    assert.deepEqual(result, {
      placed: [
        path.join(workspace, 'src', 'a.ts'),
        path.join(workspace, 'attachments', 'notes.txt'),
        path.join(workspace, 'attachments', 'folder'),
      ],
      failed: [],
    });
    assert.equal(fs.readFileSync(path.join(workspace, 'attachments', 'folder', 'deeper', 'inner.txt'), 'utf8'), 'inner');
  });

  test('gives a copy a free name and leaves the one there alone', async () => {
    fs.writeFileSync(path.join(workspace, 'attachments', 'notes.txt'), 'kept');
    const result = await placeInWorkspace([path.join(outside, 'notes.txt')], workspace, 'attachments', NullLogger);
    assert.deepEqual(result.placed, [path.join(workspace, 'attachments', 'notes (1).txt')]);
    assert.equal(fs.readFileSync(path.join(workspace, 'attachments', 'notes.txt'), 'utf8'), 'kept');
  });

  test('reports what could not be copied and goes on with the rest', async () => {
    const result = await placeInWorkspace(
      [path.join(outside, 'gone.txt'), path.join(outside, 'notes.txt')],
      workspace,
      'inbox',
      NullLogger,
    );
    assert.deepEqual(result, { placed: [path.join(workspace, 'inbox', 'notes.txt')], failed: [path.join(outside, 'gone.txt')] });
  });
});
