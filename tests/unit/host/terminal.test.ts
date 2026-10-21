import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { findWindowsTerminal, terminalLaunch } from '../../../src/host/main/terminal';

describe('external terminal', () => {
  test('Windows Terminal when it is installed, told to start in the folder; PowerShell without it', () => {
    const wt = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';
    assert.deepEqual(terminalLaunch(undefined, wt, 'cmd.exe'), { file: 'cmd.exe', args: ['/c', 'start', wt, '-d', '.'] });
    assert.deepEqual(terminalLaunch('', undefined, 'cmd.exe').args, ['/c', 'start', 'powershell.exe']);
  });

  test('the setting wins; a path with spaces goes first as the window title too', () => {
    const bash = 'C:\\Program Files\\Git\\git-bash.exe';
    assert.deepEqual(terminalLaunch(bash, 'wt.exe', 'cmd.exe').args, ['/c', 'start', bash, bash]);
    assert.deepEqual(terminalLaunch('  wt  ', undefined, 'cmd.exe').args, ['/c', 'start', 'wt', '-d', '.']);
    assert.deepEqual(terminalLaunch(42, undefined, 'cmd.exe').args, ['/c', 'start', 'powershell.exe'], 'not a string: the default');
  });

  test("Windows Terminal is found by its app alias in the user's WindowsApps", () => {
    const local = mkdtempSync(path.join(tmpdir(), 'vilaus-wt-'));
    try {
      assert.equal(findWindowsTerminal(local), undefined);
      const apps = path.join(local, 'Microsoft', 'WindowsApps');
      mkdirSync(apps, { recursive: true });
      writeFileSync(path.join(apps, 'wt.exe'), '');
      assert.equal(findWindowsTerminal(local), path.join(apps, 'wt.exe'));
      assert.equal(findWindowsTerminal(''), undefined, 'no LOCALAPPDATA');
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });
});
