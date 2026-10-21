import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseCliArgs, parseGoto, userArguments } from '../../../src/host/main/cli';
import { SharedRecentFolders } from '../../../src/host/main/recentFolders';
import type { ILogger } from '../../../src/platform/log';
import { CASCADE_OFFSET, cascade, foldersToOpen, parsePlacement, sameFolder, WindowHistory } from '../../../src/host/main/windowHistory';

const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, child: () => silentLogger } as unknown as ILogger;

function memoryStore(): { get(key: string): unknown; set(key: string, value: unknown): void; data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (key) => data.get(key),
    set: (key, value) => (value === undefined ? data.delete(key) : data.set(key, value)),
  };
}

describe('userArguments', () => {
  test('packaged: everything after the executable', () => {
    assert.deepEqual(userArguments(['Vilausity.exe', 'C:\\w', '--new-window'], true), ['C:\\w', '--new-window']);
  });

  test('development: everything after the app path, even with switches before it', () => {
    assert.deepEqual(userArguments(['electron.exe', '.', '--folder', 'x'], false), ['--folder', 'x']);
    assert.deepEqual(userArguments(['electron.exe', '--inspect=0', '--remote-debugging-port=0', '.', '--user-data-dir', 'd'], false), [
      '--user-data-dir',
      'd',
    ]);
    assert.deepEqual(userArguments(['electron.exe', '--inspect=0'], false), []);
  });
});

describe('parseCliArgs', () => {
  test('a folder comes from --folder or the first positional, resolved against the start folder', () => {
    assert.equal(parseCliArgs(['--folder', 'a']).folder, path.resolve('a'));
    assert.equal(parseCliArgs(['b', '--devtools']).folder, path.resolve('b'));
    assert.equal(parseCliArgs(['b'], 'C:\\start').folder, 'C:\\start\\b');
    assert.equal(parseCliArgs(['--devtools']).folder, undefined);
    assert.equal(parseCliArgs(['--devtools']).devtools, true);
  });

  test("File Explorer's menu: --admin, a drive's root as it arrives, and the installer's switches", () => {
    const admin = parseCliArgs(['--admin', 'C:\\work\\shop']);
    assert.equal(admin.admin, true);
    assert.equal(admin.folder, 'C:\\work\\shop');
    // "%V" for D:\ arrives as D:" (the backslash escaped the closing quote).
    assert.equal(parseCliArgs(['D:"']).folder, 'D:\\');
    assert.equal(parseCliArgs(['--admin', 'd:"']).folder, 'd:\\');
    assert.equal(parseCliArgs(['--register-context-menu']).registerContextMenu, true);
    assert.equal(parseCliArgs(['--unregister-context-menu']).unregisterContextMenu, true);
    assert.equal(parseCliArgs([]).admin, false);
  });

  test('a vilaus:// link is a link, not a folder', () => {
    const args = parseCliArgs(['vilaus://anthropic.claude-code/open?session=x']);
    assert.equal(args.uri, 'vilaus://anthropic.claude-code/open?session=x');
    assert.equal(args.folder, undefined);
  });

  test('after -- (how the installer registers vilaus://) nothing is an option, not even what a link smuggles in', () => {
    // A link that broke out of its quotes in "Vilausity.exe" -- "%1".
    const args = parseCliArgs([
      '--',
      'vilaus://anthropic.claude-code/open',
      '--new-window',
      '--extension-dir',
      'C:\\elsewhere',
      'C:\\work',
    ]);
    assert.equal(args.uri, 'vilaus://anthropic.claude-code/open');
    assert.equal(args.newWindow, false);
    assert.equal(args.extensionDir, undefined);
    assert.equal(args.folder, undefined);
  });

  test('conversation, window and help options', () => {
    const args = parseCliArgs(['--session', 's1', '--prompt', 'hi there', '--new-window', '-v']);
    assert.equal(args.session, 's1');
    assert.equal(args.prompt, 'hi there');
    assert.equal(args.newWindow, true);
    assert.equal(args.version, true);
    assert.equal(args.help, false);
    assert.equal(parseCliArgs(['-h']).help, true);
  });

  test('--goto takes a line and a column after the path, past a drive letter', () => {
    assert.deepEqual(parseCliArgs(['--goto', 'C:\\w\\a.ts:12:5']).goto, { path: 'C:\\w\\a.ts', line: 12, column: 5 });
    assert.deepEqual(parseGoto('C:\\w\\a.ts:3', 'C:\\x'), { path: 'C:\\w\\a.ts', line: 3, column: undefined });
    assert.deepEqual(parseGoto('a.ts', 'C:\\x'), { path: 'C:\\x\\a.ts', line: undefined, column: undefined });
    assert.deepEqual(parseGoto('a.ts:0', 'C:\\x'), { path: 'C:\\x\\a.ts', line: undefined, column: undefined });
    assert.equal(parseGoto(undefined, 'C:\\x'), undefined);
  });
});

describe('foldersToOpen', () => {
  const exists = (folder: string): boolean => !folder.includes('gone');
  const base = { exists, fallback: 'C:\\home' };

  test('the command line folder wins over the windows open last time', () => {
    assert.deepEqual(foldersToOpen({ ...base, folder: 'C:\\x', restoreAll: false, previous: ['C:\\a'] }), ['C:\\x']);
  });

  test('without one, the windows open last time come back, in order, minus missing folders and duplicates', () => {
    assert.deepEqual(foldersToOpen({ ...base, folder: undefined, restoreAll: false, previous: ['C:\\a', 'C:\\gone', 'c:\\A', 'C:\\b'] }), [
      'C:\\a',
      'C:\\b',
    ]);
  });

  test('a relaunch restores every window whatever the command line says', () => {
    assert.deepEqual(foldersToOpen({ ...base, folder: 'C:\\x', restoreAll: true, previous: ['C:\\a', 'C:\\b'] }), ['C:\\a', 'C:\\b']);
  });

  test('nothing to restore: the fallback folder', () => {
    assert.deepEqual(foldersToOpen({ ...base, folder: undefined, restoreAll: false, previous: ['C:\\gone'] }), ['C:\\home']);
    assert.deepEqual(foldersToOpen({ ...base, folder: undefined, restoreAll: true, previous: [] }), ['C:\\home']);
  });
});

describe('cascade', () => {
  test('steps down and right past windows that sit exactly there', () => {
    const bounds = { x: 10, y: 20, width: 800, height: 600 };
    assert.deepEqual(cascade(bounds, []), bounds);
    const taken = [bounds, { ...bounds, x: 10 + CASCADE_OFFSET, y: 20 + CASCADE_OFFSET }];
    assert.deepEqual(cascade(bounds, taken), { ...bounds, x: 10 + 2 * CASCADE_OFFSET, y: 20 + 2 * CASCADE_OFFSET });
  });
});

describe('WindowHistory', () => {
  test('remembers a placement per folder, whatever the case of its path', () => {
    const history = new WindowHistory(memoryStore());
    const bounds = { x: 1, y: 2, width: 3, height: 4 };
    history.rememberPlacement('C:\\Work', { bounds, maximized: true });
    assert.deepEqual(history.placement('c:\\work'), { bounds, maximized: true });
    assert.equal(history.placement('C:\\other'), undefined);
  });

  test('keeps the 50 most recently used placements', () => {
    const history = new WindowHistory(memoryStore());
    for (let i = 0; i < 55; i++) {
      history.rememberPlacement(`C:\\f${i}`, { maximized: false }, 1000 + i);
    }
    assert.equal(history.placement('C:\\f4'), undefined);
    assert.ok(history.placement('C:\\f5'));
    assert.ok(history.placement('C:\\f54'));
  });

  test('recent folders: newest first, no duplicates, removable', () => {
    const history = new WindowHistory(memoryStore());
    history.addRecent('C:\\a');
    history.addRecent('C:\\b');
    history.addRecent('c:\\A');
    assert.deepEqual(history.recentFolders(), ['c:\\A', 'C:\\b']);
    history.removeRecent('C:\\a');
    assert.deepEqual(history.recentFolders(), ['C:\\b']);
  });

  test("recent folders shared with the other instance: read again each time; an instance's own list moves in once", () => {
    let file = ['C:\\shared'];
    const shared = {
      read: () => [...file],
      write: (folders: readonly string[]) => {
        file = [...folders];
      },
    };
    const store = memoryStore();
    store.set('recentFolders', ['C:\\own', 'c:\\SHARED']);
    const history = new WindowHistory(store, shared);
    history.shareRecent();
    assert.deepEqual(history.recentFolders(), ['C:\\shared', 'C:\\own']);
    assert.equal(store.get('recentFolders'), undefined);
    // The other process added one meanwhile.
    file = ['C:\\other', ...file];
    history.addRecent('C:\\new');
    assert.deepEqual(file, ['C:\\new', 'C:\\other', 'C:\\shared', 'C:\\own']);
    history.removeRecent('c:\\other');
    assert.deepEqual(file, ['C:\\new', 'C:\\shared', 'C:\\own']);
    history.shareRecent();
    assert.deepEqual(file, ['C:\\new', 'C:\\shared', 'C:\\own'], 'nothing more to move');
  });

  test('the shared recent folders file: written and read back, values of the wrong shape dropped', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vilaus-recent-'));
    try {
      const file = path.join(dir, 'state', 'recent-folders.json');
      const recent = new SharedRecentFolders(file, silentLogger);
      assert.deepEqual(recent.read(), [], 'no file yet');
      recent.write(['C:\\a', 'C:\\b']);
      assert.deepEqual(new SharedRecentFolders(file, silentLogger).read(), ['C:\\a', 'C:\\b']);
      writeFileSync(file, JSON.stringify(['C:\\a', 3, '', null]));
      assert.deepEqual(recent.read(), ['C:\\a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the restore-all mark applies to one start', () => {
    const history = new WindowHistory(memoryStore());
    history.setRestoreAll(true);
    assert.equal(history.takeRestoreAll(), true);
    assert.equal(history.takeRestoreAll(), false);
  });

  test('ignores values of the wrong shape (a hand-edited file)', () => {
    const store = memoryStore();
    store.set('recentFolders', ['C:\\a', 3, '']);
    store.set('windowPlacements', { 'c:\\k': { folder: 'C:\\k', lastUsed: 1, bounds: { x: 'no' } }, bad: 7 });
    store.set('zoomLevel', 'big');
    const history = new WindowHistory(store);
    assert.deepEqual(history.recentFolders(), ['C:\\a']);
    assert.deepEqual(history.placement('C:\\k'), { bounds: undefined, maximized: false });
    assert.equal(history.zoomLevel(), undefined);
  });

  test('zoom level 0 is the default and not stored', () => {
    const store = memoryStore();
    const history = new WindowHistory(store);
    history.setZoomLevel(1.5);
    assert.equal(history.zoomLevel(), 1.5);
    history.setZoomLevel(0);
    assert.equal(store.data.has('zoomLevel'), false);
  });
});

describe('placement helpers', () => {
  test('parsePlacement reads what the single window used to store', () => {
    assert.deepEqual(parsePlacement({ bounds: { x: 1, y: 2, width: 3, height: 4 }, maximized: true, zoomLevel: 1 }), {
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      maximized: true,
    });
    assert.equal(parsePlacement(undefined), undefined);
  });

  test('sameFolder ignores case', () => {
    assert.ok(sameFolder('C:\\Work\\a', 'c:\\work\\A'));
    assert.ok(!sameFolder('C:\\Work\\a', 'C:\\Work\\b'));
  });
});
