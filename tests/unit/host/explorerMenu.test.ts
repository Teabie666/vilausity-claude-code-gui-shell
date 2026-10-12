import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { administratorInstanceArgs } from '../../../src/host/main/elevation';
import {
  ExplorerMenu,
  explorerMenuCommand,
  explorerMenuRegFile,
  explorerMenuRemovalRegFile,
  explorerMenuRoot,
} from '../../../src/host/main/explorerMenu';

const installed = { executable: 'C:\\Program Files\\Vilausity\\Vilausity.exe', prefixArgs: [] };
const development = { executable: 'C:\\dev\\electron.exe', prefixArgs: ['C:\\dev app'] };
const labels = { open: '用 Vilausity 打开', openAsAdministrator: '用 Vilausity 打开（管理员）' };
/** Test runs write under this key (the UI test too), each in a key of its own. */
const TEST_PARENT = 'HKCU\\Software\\Vilausity-test';
const TEST_PARENT_FULL = 'HKEY_CURRENT_USER\\Software\\Vilausity-test';

describe("File Explorer's menu", () => {
  test('the entries run this program on "%V", the administrator one with --admin', () => {
    assert.equal(explorerMenuCommand(installed, false), '"C:\\Program Files\\Vilausity\\Vilausity.exe" "%V"');
    assert.equal(explorerMenuCommand(development, true), 'C:\\dev\\electron.exe "C:\\dev app" --admin "%V"');
  });

  test('the .reg file: a folder, its background and a drive, each with both entries; escaped', () => {
    const text = explorerMenuRegFile('HKCU\\Software\\Classes', installed, labels);
    const lines = text.split('\r\n');
    assert.equal(lines[0], 'Windows Registry Editor Version 5.00');
    for (const parent of ['Directory\\shell', 'Directory\\Background\\shell', 'Drive\\shell']) {
      const key = `HKEY_CURRENT_USER\\Software\\Classes\\${parent}`;
      for (const verb of ['Vilausity', 'VilausityAdministrator']) {
        assert.ok(lines.includes(`[${key}\\${verb}]`), `${parent} ${verb}`);
        assert.ok(lines.includes(`[${key}\\${verb}\\command]`), `${parent} ${verb} command`);
      }
    }
    assert.ok(lines.includes('@="用 Vilausity 打开"'));
    assert.ok(lines.includes('@="用 Vilausity 打开（管理员）"'));
    assert.ok(lines.includes('"Icon"="C:\\\\Program Files\\\\Vilausity\\\\Vilausity.exe"'));
    assert.ok(lines.includes('@="\\"C:\\\\Program Files\\\\Vilausity\\\\Vilausity.exe\\" \\"%V\\""'));
    // The shield on the administrator entries only.
    assert.equal(lines.filter((line) => line === '"HasLUAShield"=""').length, 3);
  });

  test('the removal file deletes the six keys', () => {
    const lines = explorerMenuRemovalRegFile('HKCU\\Software\\Classes').split('\r\n');
    assert.equal(lines.filter((line) => line.startsWith('[-HKEY_CURRENT_USER\\Software\\Classes\\')).length, 6);
  });

  test('tests can point the entries elsewhere', () => {
    assert.equal(explorerMenuRoot({}), 'HKCU\\Software\\Classes');
    assert.equal(explorerMenuRoot({ VILAUS_REGISTRY_ROOT: 'HKCU\\Software\\Test' }), 'HKCU\\Software\\Test');
  });

  test('the administrator instance gets the folder, after the app folder in development', () => {
    assert.deepEqual(administratorInstanceArgs('D:\\', undefined, undefined), ['D:\\']);
    assert.deepEqual(administratorInstanceArgs('C:\\w', 'C:\\dev app', 'C:\\data'), [
      'C:\\dev app',
      'C:\\w',
      '--user-data-dir',
      'C:\\data',
    ]);
  });

  test('written to the registry and removed again (under a test key)', { skip: process.platform !== 'win32' }, async () => {
    const testKey = `${TEST_PARENT}\\unit-${process.pid}-${Date.now()}`;
    const root = `${testKey}\\Classes`;
    const folder = mkdtempSync(path.join(os.tmpdir(), 'vilaus-reg-test-'));
    const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
    try {
      const menu = new ExplorerMenu(root, installed);
      assert.equal(await menu.isRegistered(), false);
      await menu.register(labels);
      assert.equal(await menu.isRegistered(), true);
      // reg export writes UTF-16: the labels and the command as Explorer will read them.
      const exported = path.join(folder, 'out.reg');
      execFileSync(reg, ['export', `${root}\\Directory\\Background\\shell`, exported, '/y'], { windowsHide: true });
      const text = readFileSync(exported).toString('utf16le');
      assert.ok(text.includes('@="用 Vilausity 打开（管理员）"'));
      assert.ok(text.includes('@="\\"C:\\\\Program Files\\\\Vilausity\\\\Vilausity.exe\\" --admin \\"%V\\""'));
      // Written again over itself (the start of an installed copy does that), then removed.
      await menu.register(labels);
      await menu.unregister();
      assert.equal(await menu.isRegistered(), false);
      // Removing what is not there is no error.
      await menu.unregister();
    } finally {
      for (const key of [testKey, TEST_PARENT]) {
        try {
          // The parent only once no other run keeps a key in it.
          const left = key === TEST_PARENT ? execFileSync(reg, ['query', key], { windowsHide: true, encoding: 'latin1' }) : '';
          if (!left.includes(`${TEST_PARENT_FULL}\\`)) {
            execFileSync(reg, ['delete', key, '/f'], { windowsHide: true, stdio: 'ignore' });
          }
        } catch {
          // Already gone.
        }
      }
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
