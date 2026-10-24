import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NullLogger } from '../../../src/platform/log';
import { ShellCounters } from '../../../src/host/main/shellCounters';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vilaus-counters-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ShellCounters', () => {
  test('counts increments and distinct folders', () => {
    const counters = new ShellCounters(path.join(root, 'counting.json'), NullLogger);
    counters.increment('launches');
    counters.increment('launches');
    counters.increment('filesDropped', 5);
    counters.folderOpened(path.join(root, 'a'));
    counters.folderOpened(path.join(root, 'b'));
    counters.folderOpened(path.join(root, 'a')); // already there
    const read = counters.read();
    assert.equal(read.launches, 2);
    assert.equal(read.filesDropped, 5);
    assert.equal(read.foldersOpened, 3);
    assert.equal(read.distinctFolders, 2);
    assert.ok(read.since > 0);
  });

  test('since is set on the first increment and kept', async () => {
    const file = path.join(root, 'since.json');
    const counters = new ShellCounters(file, NullLogger);
    const before = Date.now();
    counters.increment('launches');
    assert.ok(counters.read().since >= before);
    await counters.flush();
    const again = new ShellCounters(file, NullLogger);
    assert.equal(again.read().since, counters.read().since);
  });

  test('two instances writing one after another keep both counts', async () => {
    const file = path.join(root, 'counters.json');
    const first = new ShellCounters(file, NullLogger);
    const second = new ShellCounters(file, NullLogger);
    first.increment('launches');
    first.increment('comments');
    second.increment('launches');
    second.folderOpened(path.join(root, 'workspace-a'));
    await first.flush();
    await second.flush();
    const merged = new ShellCounters(file, NullLogger).read();
    assert.equal(merged.launches, 2);
    assert.equal(merged.comments, 1);
    assert.equal(merged.foldersOpened, 1);
    assert.equal(merged.distinctFolders, 1);
    assert.ok(merged.since > 0);
  });

  test('a corrupt file is treated as empty', () => {
    const file = path.join(root, 'corrupt.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    const read = new ShellCounters(file, NullLogger).read();
    assert.equal(read.launches, 0);
    assert.equal(read.foldersOpened, 0);
    assert.equal(read.distinctFolders, 0);
    assert.equal(read.comments, 0);
  });
});
