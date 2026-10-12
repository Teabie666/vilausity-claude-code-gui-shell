import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { ExtensionStore, systemTar } from '../../../src/host/main/extensionStore';
import { ExtensionUpdater, type UpdateSettings } from '../../../src/host/main/extensionUpdater';
import type { LocatedExtension } from '../../../src/host/main/extensionLocator';
import {
  checkPackage,
  parseOpenVsxRelease,
  rollBackTo,
  shouldInstall,
  switchToPending,
  vsixIdentity,
} from '../../../src/platform/extensionUpdates';
import { NullLogger } from '../../../src/platform/log';

const PLATFORM = 'win32-x64';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vilaus-extensions-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('extension update decisions', () => {
  test('the pending version becomes current at startup, the current one previous', () => {
    const installed = (): boolean => true;
    assert.deepEqual(switchToPending({ current: '1.0.0', pending: '1.0.1' }, installed), {
      current: '1.0.1',
      previous: '1.0.0',
    });
    // The first managed copy: nothing to keep.
    assert.deepEqual(switchToPending({ pending: '1.0.0' }, installed), { current: '1.0.0' });
    // Pending but gone from disk: dropped.
    assert.deepEqual(
      switchToPending({ current: '1.0.0', pending: '1.0.1' }, () => false),
      { current: '1.0.0' },
    );
  });

  test('rolling back makes the target pending and skips the current version', () => {
    assert.deepEqual(rollBackTo({ current: '1.0.1', previous: '1.0.0', lastGood: '1.0.0' }, '1.0.0'), {
      current: '1.0.1',
      previous: '1.0.0',
      lastGood: '1.0.0',
      pending: '1.0.0',
      skipped: '1.0.1',
    });
    // Then at the next start the two swap places.
    assert.deepEqual(
      switchToPending({ current: '1.0.1', previous: '1.0.0', pending: '1.0.0', skipped: '1.0.1' }, () => true),
      {
        current: '1.0.0',
        previous: '1.0.1',
        skipped: '1.0.1',
      },
    );
  });

  test('what to install', () => {
    const state = { current: '2.1.282' };
    const base = { state, running: '2.1.282', pinned: false, manual: false };
    assert.equal(shouldInstall({ ...base, available: '2.1.296' }), true);
    assert.equal(shouldInstall({ ...base, available: '2.1.282' }), false);
    assert.equal(shouldInstall({ ...base, available: '2.1.100' }), false);
    // Compared numerically, not as text.
    assert.equal(shouldInstall({ ...base, state: { current: '2.1.9' }, available: '2.1.10' }), true);
    // Against what is pending.
    assert.equal(shouldInstall({ ...base, state: { current: '2.1.282', pending: '2.1.296' }, available: '2.1.296' }), false);
    // A VSCodium copy and no managed one.
    assert.equal(shouldInstall({ ...base, state: {}, running: '2.1.300', available: '2.1.296' }), false);
    assert.equal(shouldInstall({ ...base, state: {}, running: undefined, available: '2.1.296' }), true);
    // Rolled back from: only on request.
    const skipped = { current: '2.1.282', skipped: '2.1.296' };
    assert.equal(shouldInstall({ ...base, state: skipped, available: '2.1.296' }), false);
    assert.equal(shouldInstall({ ...base, state: skipped, available: '2.1.296', manual: true }), true);
    assert.equal(shouldInstall({ ...base, state: skipped, available: '2.1.297' }), true);
    // Pinned: back as well as forward, never away from it.
    assert.equal(shouldInstall({ ...base, state: { current: '2.1.296' }, available: '2.1.282', pinned: true }), true);
    assert.equal(shouldInstall({ ...base, available: '2.1.282', pinned: true }), false);
  });

  test('Open VSX metadata', () => {
    const release = {
      namespace: 'Anthropic',
      name: 'claude-code',
      version: '2.1.282',
      targetPlatform: PLATFORM,
      files: { download: 'https://x/a.vsix', sha256: 'https://x/a.sha256' },
    };
    assert.deepEqual(parseOpenVsxRelease(release, PLATFORM), {
      version: '2.1.282',
      download: 'https://x/a.vsix',
      sha256: 'https://x/a.sha256',
    });
    assert.equal(parseOpenVsxRelease({ ...release, targetPlatform: 'darwin-arm64' }, PLATFORM), undefined);
    assert.equal(parseOpenVsxRelease({ ...release, name: 'other' }, PLATFORM), undefined);
    assert.equal(parseOpenVsxRelease({ ...release, version: '../2' }, PLATFORM), undefined);
    assert.equal(parseOpenVsxRelease({ error: 'not found' }, PLATFORM), undefined);
  });

  test('package checks', () => {
    const identity = vsixIdentity(
      '<PackageManifest><Metadata><Identity Language="en-US" Id="claude-code" Version="2.1.282" Publisher="Anthropic" TargetPlatform="win32-x64"/></Metadata></PackageManifest>',
    );
    assert.equal(identity.TargetPlatform, PLATFORM);
    const pkg = { publisher: 'Anthropic', name: 'claude-code', version: '2.1.282', main: './extension.js' };
    assert.deepEqual(checkPackage(pkg, identity, PLATFORM), { version: '2.1.282' });
    assert.deepEqual(checkPackage({ ...pkg, publisher: 'someone' }, identity, PLATFORM), { error: 'notClaudeCode' });
    assert.deepEqual(checkPackage(pkg, { TargetPlatform: 'linux-x64' }, PLATFORM), { error: 'wrongPlatform' });
    assert.deepEqual(checkPackage({ ...pkg, main: undefined }, identity, PLATFORM), { error: 'badPackage' });
  });
});

// ---- Installing for real: packages made with bsdtar, a local Open VSX. ----

interface PackageOptions {
  readonly publisher?: string;
  readonly platform?: string;
}

/** A .vsix like Open VSX's: `extension/` and `extension.vsixmanifest` in a zip. */
function makeVsix(version: string, options: PackageOptions = {}): Buffer {
  const dir = fs.mkdtempSync(path.join(root, 'pkg-'));
  fs.mkdirSync(path.join(dir, 'extension'));
  const publisher = options.publisher ?? 'Anthropic';
  fs.writeFileSync(
    path.join(dir, 'extension', 'package.json'),
    JSON.stringify({ publisher, name: 'claude-code', version, main: './extension.js' }),
  );
  fs.writeFileSync(path.join(dir, 'extension', 'extension.js'), `exports.version = ${JSON.stringify(version)};\n`);
  fs.writeFileSync(
    path.join(dir, 'extension.vsixmanifest'),
    `<PackageManifest><Metadata><Identity Id="claude-code" Version="${version}" Publisher="${publisher}" TargetPlatform="${options.platform ?? PLATFORM}"/></Metadata></PackageManifest>`,
  );
  // bsdtar picks the format from the suffix; .vsix is not one it knows.
  execFileSync(systemTar(), ['-a', '-c', '-f', 'package.zip', 'extension', 'extension.vsixmanifest'], { cwd: dir });
  const bytes = fs.readFileSync(path.join(dir, 'package.zip'));
  fs.rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** A local Open VSX: the latest release, per-version metadata, a redirect to the file, the sha256. */
class FakeOpenVsx {
  readonly packages = new Map<string, Buffer>();
  latest = '';
  /** Versions whose published sha256 does not match the file. */
  readonly corrupt = new Set<string>();
  private server!: http.Server;
  url = '';

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => this.serve(request.url ?? '', response));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  publish(version: string, options?: PackageOptions): void {
    this.packages.set(version, makeVsix(version, options));
    this.latest = version;
  }

  private serve(url: string, response: http.ServerResponse): void {
    const api = /^\/api\/anthropic\/claude-code\/win32-x64(?:\/([^/]+))?$/.exec(url);
    if (api) {
      const version = api[1] ?? this.latest;
      if (!this.packages.has(version)) {
        response.writeHead(404).end('{"error":"not found"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          namespace: 'Anthropic',
          name: 'claude-code',
          version,
          targetPlatform: PLATFORM,
          files: { download: `${this.url}/file/${version}.vsix`, sha256: `${this.url}/file/${version}.sha256` },
        }),
      );
      return;
    }
    const file = /^\/(file|blob)\/([^/]+)\.(vsix|sha256)$/.exec(url);
    const bytes = file ? this.packages.get(file[2]!) : undefined;
    if (!file || !bytes) {
      response.writeHead(404).end();
    } else if (file[3] === 'sha256') {
      const sum = crypto.createHash('sha256').update(bytes).digest('hex');
      response.writeHead(200).end(this.corrupt.has(file[2]!) ? sum.replace(/^./, sum[0] === '0' ? '1' : '0') : sum);
    } else if (file[1] === 'file') {
      // Open VSX redirects downloads to its storage.
      response.writeHead(302, { location: `${this.url}/blob/${file[2]}.vsix` }).end();
    } else {
      response.writeHead(200, { 'content-length': bytes.length }).end(bytes);
    }
  }
}

describe('installing the extension', () => {
  const server = new FakeOpenVsx();
  const dir = path.join(root, 'extensions');
  let pinned: string | undefined;
  let running: LocatedExtension | undefined;
  const settings = (): UpdateSettings => ({ openVsxUrl: server.url, pinned });
  /** What a start of the app does: switch, then an updater for what runs. */
  const start = (): { store: ExtensionStore; updater: ExtensionUpdater } => {
    const store = new ExtensionStore(dir, PLATFORM, NullLogger);
    running = store.prepare();
    const updater = new ExtensionUpdater({
      store,
      fetch,
      targetPlatform: PLATFORM,
      running,
      external: undefined,
      settings,
      logger: NullLogger,
    });
    return { store, updater };
  };

  before(() => server.start());
  after(() => server.stop());

  test('downloads, checks and installs the latest; it is used from the next start', async () => {
    server.publish('2.0.1');
    const { store, updater } = start();
    assert.equal(store.currentCopy(), undefined);
    const progress: string[] = [];
    updater.onDidChange(() => progress.push(updater.status().activity.kind));
    assert.deepEqual(await updater.check(false), { outcome: 'installed', version: '2.0.1' });
    assert.deepEqual(store.state, { pending: '2.0.1' });
    assert.ok(progress.includes('checking') && progress.includes('downloading') && progress.includes('installing'));
    assert.equal(updater.status().activity.kind, 'idle');
    assert.equal(updater.status().lastCheck?.outcome, 'installed');
    // Nothing left of the download.
    assert.deepEqual(fs.readdirSync(path.join(dir, '.downloads')), []);

    const next = start();
    assert.equal(running?.version, '2.0.1');
    assert.equal(running?.kind, 'managed');
    assert.equal(fs.readFileSync(path.join(running!.path, 'extension.js'), 'utf8'), 'exports.version = "2.0.1";\n');
    assert.deepEqual(await next.updater.check(false), { outcome: 'upToDate', version: '2.0.1' });
  });

  test('an update keeps the version before it; a rollback skips the bad one', async () => {
    server.publish('2.0.2');
    const first = start();
    assert.deepEqual(await first.updater.check(false), { outcome: 'installed', version: '2.0.2' });
    const second = start();
    // (A copy: asserting on the getter itself would narrow its type for the lines below.)
    assert.deepEqual({ ...second.store.state }, { current: '2.0.2', previous: '2.0.1' });
    await second.store.markGood('2.0.2');
    assert.equal(second.store.state.lastGood, '2.0.2');

    assert.deepEqual(second.updater.status().rollback, {
      version: '2.0.1',
      from: 'managed',
      path: second.store.versionDir('2.0.1'),
    });
    assert.deepEqual(await second.updater.rollBack(), { outcome: 'installed', version: '2.0.1' });
    const third = start();
    assert.equal(running?.version, '2.0.1');
    assert.deepEqual(third.store.state, { current: '2.0.1', previous: '2.0.2', lastGood: '2.0.2', skipped: '2.0.2' });
    // Automatic checks leave the skipped version alone; asking installs it (from disk).
    assert.deepEqual(await third.updater.check(false), { outcome: 'upToDate', version: '2.0.2' });
    assert.deepEqual(await third.updater.check(true), { outcome: 'installed', version: '2.0.2' });
    assert.deepEqual(third.store.state, { current: '2.0.1', previous: '2.0.2', lastGood: '2.0.2', pending: '2.0.2' });
    start();
    assert.equal(running?.version, '2.0.2');
  });

  test('only the current, previous and pending versions stay on disk', async () => {
    server.publish('2.0.3');
    const { updater } = start();
    await updater.check(false);
    start();
    const names = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('anthropic.claude-code-'))
      .sort();
    assert.deepEqual(names, ['anthropic.claude-code-2.0.2', 'anthropic.claude-code-2.0.3']);
  });

  test('a pinned version is installed even when older', async () => {
    pinned = '2.0.1';
    try {
      const { updater } = start();
      assert.deepEqual(await updater.check(false), { outcome: 'installed', version: '2.0.1' });
      start();
      assert.equal(running?.version, '2.0.1');
      pinned = '9.9.9';
      const result = await start().updater.check(false);
      assert.equal(result.outcome === 'failed' && result.code, 'notFound');
    } finally {
      pinned = undefined;
    }
  });

  test('a download whose sha256 does not match is thrown away', async () => {
    server.publish('2.0.4');
    server.corrupt.add('2.0.4');
    const { store, updater } = start();
    const result = await updater.check(false);
    assert.equal(result.outcome === 'failed' && result.code, 'checksum');
    assert.equal(store.state.pending, undefined);
    assert.equal(store.isInstalled('2.0.4'), false);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.downloads')), []);
  });

  test('a .vsix file: checked for publisher, name and platform', async () => {
    const write = (name: string, bytes: Buffer): string => {
      const file = path.join(root, name);
      fs.writeFileSync(file, bytes);
      return file;
    };
    const { store, updater } = start();
    const other = await updater.installFile(write('other.vsix', makeVsix('3.0.0', { publisher: 'someone' })));
    assert.equal(other.outcome === 'failed' && other.code, 'notClaudeCode');
    const mac = await updater.installFile(write('mac.vsix', makeVsix('3.0.0', { platform: 'darwin-arm64' })));
    assert.equal(mac.outcome === 'failed' && mac.code, 'wrongPlatform');
    const junk = await updater.installFile(write('junk.vsix', Buffer.from('not a zip file')));
    assert.equal(junk.outcome === 'failed' && junk.code, 'extract');
    assert.equal(store.state.pending, undefined);

    assert.deepEqual(await updater.installFile(write('good.vsix', makeVsix('3.0.0'))), { outcome: 'installed', version: '3.0.0' });
    assert.equal(store.state.pending, '3.0.0');
    // Nothing half-unpacked left behind.
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.startsWith('.staging-')),
      [],
    );
    start();
    assert.equal(running?.version, '3.0.0');
  });

  test('a current version deleted by hand falls back to the previous one', () => {
    const { store } = start();
    const { current, previous } = store.state;
    assert.ok(current && previous);
    fs.rmSync(store.versionDir(current), { recursive: true, force: true });
    start();
    assert.equal(running?.version, previous);
  });
});

/** An unpacked copy as VSCodium keeps it: no .vsixmanifest (or `.vsixmanifest`), just the files. */
function makeFolder(version: string): LocatedExtension {
  const folder = fs.mkdtempSync(path.join(root, `vscodium-${version}-`));
  fs.writeFileSync(
    path.join(folder, 'package.json'),
    JSON.stringify({ publisher: 'Anthropic', name: 'claude-code', version, main: './extension.js' }),
  );
  fs.writeFileSync(path.join(folder, 'extension.js'), `exports.version = ${JSON.stringify(version)};\n`);
  return { path: folder, version, source: path.dirname(folder), kind: 'external' };
}

describe("going back to another editor's copy", () => {
  const server = new FakeOpenVsx();
  let dir = '';
  let running: LocatedExtension | undefined;
  const settings = (): UpdateSettings => ({ openVsxUrl: server.url, pinned: undefined });
  /** A start of the app with `external` installed elsewhere: the managed copy first, else that one. */
  const start = (external?: LocatedExtension): { store: ExtensionStore; updater: ExtensionUpdater } => {
    const store = new ExtensionStore(dir, PLATFORM, NullLogger);
    running = store.prepare() ?? external;
    const updater = new ExtensionUpdater({ store, fetch, targetPlatform: PLATFORM, running, external, settings, logger: NullLogger });
    return { store, updater };
  };

  before(() => server.start());
  after(() => server.stop());

  test('the first update backs up the copy another editor had, as the version to go back to', async () => {
    dir = path.join(root, 'backup-first');
    const vscodium = makeFolder('2.0.0');
    server.publish('2.1.0');
    const first = start(vscodium);
    assert.equal(running?.kind, 'external');
    assert.deepEqual(await first.updater.check(false), { outcome: 'installed', version: '2.1.0' });
    assert.deepEqual({ ...first.store.state }, { pending: '2.1.0', previous: '2.0.0' });
    assert.ok(first.store.isInstalled('2.0.0'));

    // VSCodium moves on (or the copy goes away): the backup stays.
    fs.rmSync(vscodium.path, { recursive: true, force: true });
    const second = start();
    assert.equal(running?.version, '2.1.0');
    assert.deepEqual(second.updater.status().rollback, {
      version: '2.0.0',
      from: 'managed',
      path: second.store.versionDir('2.0.0'),
    });
    assert.deepEqual(await second.updater.rollBack(), { outcome: 'installed', version: '2.0.0' });
    start();
    assert.equal(running?.version, '2.0.0');
    assert.equal(fs.readFileSync(path.join(running!.path, 'extension.js'), 'utf8'), 'exports.version = "2.0.0";\n');
  });

  test("without a backup, Go Back takes another editor's older copy into the store first", async () => {
    dir = path.join(root, 'backup-later');
    const file = path.join(root, 'later.vsix');
    fs.writeFileSync(file, makeVsix('2.2.0'));
    // Installed with nothing else around: no copy to back up.
    await start().updater.installFile(file);
    const vscodium = makeFolder('2.1.5');
    const { store, updater } = start(vscodium);
    assert.equal(running?.version, '2.2.0');
    assert.equal(store.state.previous, undefined);
    assert.deepEqual(updater.status().rollback, { version: '2.1.5', from: 'external', path: vscodium.path });
    assert.deepEqual(await updater.rollBack(), { outcome: 'installed', version: '2.1.5' });
    assert.ok(store.isInstalled('2.1.5'));
    assert.deepEqual({ ...store.state }, { current: '2.2.0', pending: '2.1.5', skipped: '2.2.0' });
    start(vscodium);
    assert.equal(running?.kind, 'managed');
    assert.equal(running?.version, '2.1.5');
  });

  test('nothing to go back to: no previous version, and no older copy elsewhere', async () => {
    dir = path.join(root, 'backup-none');
    const file = path.join(root, 'none.vsix');
    fs.writeFileSync(file, makeVsix('2.3.0'));
    await start().updater.installFile(file);
    for (const external of [undefined, makeFolder('2.4.0')]) {
      const { updater } = start(external);
      assert.equal(updater.status().rollback, undefined);
      const result = await updater.rollBack();
      assert.equal(result.outcome === 'failed' && result.code, 'noPrevious');
    }
  });
});
