import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createAppPaths } from '../../../src/host/main/appPaths';
import { elevatedStartScript, isElevated, quoteWindowsArgument } from '../../../src/host/main/elevation';
import { shareSafeStorageKey } from '../../../src/host/main/safeStorageKey';
import { NullLogger } from '../../../src/platform/log';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vilaus-admin-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('the administrator instance', () => {
  test('VILAUS_ELEVATED decides when set; elsewhere than Windows, never elevated', () => {
    assert.equal(isElevated({ VILAUS_ELEVATED: '1' }), true);
    assert.equal(isElevated({ VILAUS_ELEVATED: '0' }), false);
    assert.equal(isElevated({}, 'linux'), false);
  });

  test('its state, logs and Chromium profile are its own; settings, providers and extensions are shared', () => {
    const normal = createAppPaths('D:\\data', new Date(0), false);
    const admin = createAppPaths('D:\\data', new Date(0), true);
    assert.equal(normal.instanceRoot, 'D:\\data');
    assert.equal(admin.instanceRoot, path.join('D:\\data', 'admin'));
    for (const key of ['settingsFile', 'providersFile', 'extensionsDir'] as const) {
      assert.equal(admin[key], normal[key], key);
    }
    for (const key of ['globalStateFile', 'shellStateFile', 'chromium', 'logsRoot', 'extensionGlobalStorage'] as const) {
      assert.ok(admin[key].startsWith(admin.instanceRoot + path.sep), key);
    }
    assert.equal(admin.workspaceStateFile('k'), path.join('D:\\data', 'admin', 'state', 'workspaces', 'k.json'));
    assert.equal(normal.otherChromium, admin.chromium);
    assert.equal(admin.otherChromium, normal.chromium);
    assert.equal(normal.otherShellStateFile, admin.shellStateFile);
    assert.equal(admin.otherShellStateFile, normal.shellStateFile);
  });

  test('command-line arguments quoted the way Windows reads them back', () => {
    assert.equal(quoteWindowsArgument('plain'), 'plain');
    assert.equal(quoteWindowsArgument(''), '""');
    assert.equal(quoteWindowsArgument('C:\\Made by Claude (Code)\\ccshell'), '"C:\\Made by Claude (Code)\\ccshell"');
    // A trailing backslash would escape the closing quote: doubled.
    assert.equal(quoteWindowsArgument('C:\\a b\\'), '"C:\\a b\\\\"');
    assert.equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteWindowsArgument('a\\"b c'), '"a\\\\\\"b c"');
  });

  test('the PowerShell script asks for elevation, with PowerShell quotes doubled', () => {
    assert.equal(
      elevatedStartScript("C:\\It's\\electron.exe", ['C:\\app dir', 'C:\\folder']),
      `Start-Process -FilePath 'C:\\It''s\\electron.exe' -ArgumentList '"C:\\app dir" C:\\folder' -Verb RunAs`,
    );
  });
});

describe("safeStorage's key, shared", () => {
  const profile = (name: string, localState?: unknown): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (localState !== undefined) {
      fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify(localState));
    }
    return dir;
  };
  const keyIn = (dir: string): unknown =>
    (JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8')) as { os_crypt?: { encrypted_key?: unknown } }).os_crypt
      ?.encrypted_key;

  test("the administrator takes the normal instance's key, keeping the rest of its Local State", () => {
    const normal = profile('a-normal', { os_crypt: { encrypted_key: 'NORMAL', audit_enabled: true } });
    const admin = profile('a-admin', { os_crypt: { encrypted_key: 'ADMIN' }, browser: { x: 1 } });
    assert.equal(shareSafeStorageKey(admin, normal, true, NullLogger), true);
    assert.equal(keyIn(admin), 'NORMAL');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(admin, 'Local State'), 'utf8')).browser, { x: 1 });
    // Already the same: nothing to write.
    assert.equal(shareSafeStorageKey(admin, normal, true, NullLogger), false);
  });

  test('a fresh administrator profile gets one; the normal instance keeps its own', () => {
    const normal = profile('b-normal', { os_crypt: { encrypted_key: 'NORMAL' } });
    const admin = profile('b-admin');
    assert.equal(shareSafeStorageKey(admin, normal, true, NullLogger), true);
    assert.equal(keyIn(admin), 'NORMAL');
    const other = profile('b-admin2', { os_crypt: { encrypted_key: 'ADMIN' } });
    assert.equal(shareSafeStorageKey(normal, other, false, NullLogger), false);
    assert.equal(keyIn(normal), 'NORMAL');
  });

  test("the normal instance takes the administrator's key only while it has none", () => {
    const admin = profile('c-admin', { os_crypt: { encrypted_key: 'ADMIN' } });
    const normal = profile('c-normal', { other: true });
    assert.equal(shareSafeStorageKey(normal, admin, false, NullLogger), true);
    assert.equal(keyIn(normal), 'ADMIN');
  });

  test('no key anywhere, or an unreadable Local State: nothing is written', () => {
    const a = profile('d-a');
    const b = profile('d-b');
    assert.equal(shareSafeStorageKey(a, b, true, NullLogger), false);
    assert.equal(fs.existsSync(path.join(a, 'Local State')), false);
    fs.writeFileSync(path.join(b, 'Local State'), '{not json');
    assert.equal(shareSafeStorageKey(a, b, true, NullLogger), false);
  });
});
