import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { storageItems, type StorageTarget } from '../../../src/host/main/statsStorage';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vilaus-statsstorage-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('storageItems', () => {
  test('counts the bytes and files under each directory, recursively', async () => {
    const dir = path.join(root, 'data');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), '12345');
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), '123');
    const items = await storageItems([{ id: 'logs', path: dir }]);
    assert.deepEqual(items, [{ id: 'logs', path: dir, bytes: 8, files: 2 }]);
  });

  test('omits directories that are not there', async () => {
    const items = await storageItems([
      { id: 'logs', path: path.join(root, 'missing') },
      { id: 'extensions', path: path.join(root, 'also-missing') },
    ]);
    assert.deepEqual(items, []);
  });

  test('dirs counts several directories under one item', async () => {
    const dir = path.join(root, 'chromium');
    fs.mkdirSync(path.join(dir, 'Cache'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Code Cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Cache', '1'), 'a');
    fs.writeFileSync(path.join(dir, 'Code Cache', '2'), 'bb');
    fs.writeFileSync(path.join(dir, 'Local State'), 'cccc'); // not counted
    const items = await storageItems([{ id: 'cache', path: dir, dirs: [path.join(dir, 'Cache'), path.join(dir, 'Code Cache')] }]);
    assert.deepEqual(items, [{ id: 'cache', path: dir, bytes: 3, files: 2 }]);
  });

  test('shellData leaves out the directories counted as other items', async () => {
    const instance = path.join(root, 'instance');
    fs.mkdirSync(path.join(instance, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(instance, 'transcripts'), { recursive: true });
    fs.mkdirSync(path.join(instance, 'state'), { recursive: true });
    fs.writeFileSync(path.join(instance, 'settings.json'), '{}');
    fs.writeFileSync(path.join(instance, 'logs', 'main.log'), 'log');
    fs.writeFileSync(path.join(instance, 'transcripts', 't.md'), 'trans');
    fs.writeFileSync(path.join(instance, 'state', 'c.json'), 'c');

    const targets: StorageTarget[] = [
      { id: 'logs', path: path.join(instance, 'logs') },
      { id: 'fullTranscripts', path: path.join(instance, 'transcripts') },
      {
        id: 'shellData',
        path: instance,
        except: [path.join(instance, 'logs'), path.join(instance, 'transcripts')],
      },
    ];
    const items = await storageItems(targets);
    const shell = items.find((item) => item.id === 'shellData');
    assert.ok(shell);
    assert.equal(shell.bytes, 3); // settings.json (2) + state/c.json (1)
    assert.equal(shell.files, 2);
  });
});
