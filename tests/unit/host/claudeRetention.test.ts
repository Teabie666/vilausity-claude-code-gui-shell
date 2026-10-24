import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyRetention, KEEP_FOREVER_DAYS, retentionEdit } from '../../../src/host/main/claudeRetention';

const valueOf = (text: string | undefined): unknown => (text === undefined ? undefined : JSON.parse(text).cleanupPeriodDays);

describe('retentionEdit', () => {
  test('sets the period when it is not set, in a file or none, keeping the rest and its comments; never is 36500 days', () => {
    assert.equal(valueOf(retentionEdit(undefined, 0, undefined).edited), KEEP_FOREVER_DAYS);
    assert.equal(valueOf(retentionEdit('', 90, undefined).edited), 90);
    const { edited, state } = retentionEdit('{\n  // mine\n  "model": "fable",\n  "theme": "dark"\n}\n', 0, undefined);
    assert.ok(edited?.includes('// mine'));
    assert.ok(edited?.includes('"model": "fable"'));
    assert.ok(edited?.includes(`"cleanupPeriodDays": ${KEEP_FOREVER_DAYS}`));
    assert.deepEqual(state, { days: KEEP_FOREVER_DAYS, ownValue: false });
  });

  test('changes the period it wrote itself, or the 36500 days written before it remembered', () => {
    assert.equal(valueOf(retentionEdit('{ "cleanupPeriodDays": 90 }', 30, 90).edited), 30);
    assert.equal(valueOf(retentionEdit(`{ "cleanupPeriodDays": ${KEEP_FOREVER_DAYS} }`, 60, undefined).edited), 60);
    // Already as wanted: nothing to write, and it is ours.
    assert.deepEqual(retentionEdit('{ "cleanupPeriodDays": 60 }', 60, undefined), {
      edited: undefined,
      state: { days: 60, ownValue: false },
    });
  });

  test("leaves a period of someone else's, and says so", () => {
    assert.deepEqual(retentionEdit('{ "cleanupPeriodDays": 45 }', 0, undefined), {
      edited: undefined,
      state: { days: 45, ownValue: true },
    });
    assert.deepEqual(retentionEdit('{ "cleanupPeriodDays": 45 }', 30, 90), { edited: undefined, state: { days: 45, ownValue: true } });
    // Once Vilausity wrote 90, a hand-set 36500 is someone else's.
    assert.equal(retentionEdit(`{ "cleanupPeriodDays": ${KEEP_FOREVER_DAYS} }`, 30, 90).state.ownValue, true);
  });

  test('a file that is not a JSON object is left as it is', () => {
    for (const text of ['{ "model": ', '[1, 2]', '"text"']) {
      assert.deepEqual(retentionEdit(text, 0, undefined), { edited: undefined, state: { days: undefined, ownValue: false } });
    }
  });

  test("keeps the file's line ends", () => {
    const { edited } = retentionEdit('{\r\n  "model": "fable"\r\n}\r\n', 0, undefined);
    assert.ok(edited?.includes('\r\n'));
    assert.ok(!edited?.replace(/\r\n/g, '').includes('\n'));
  });
});

describe('applyRetention', () => {
  test('writes the period and remembers it, then changes it; a period of the user leaves it alone', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-retention-'));
    const file = path.join(dir, 'settings.json');
    const written = path.join(dir, 'state', 'claude-retention.json');
    try {
      assert.deepEqual(await applyRetention(dir, 0, written), { days: KEEP_FOREVER_DAYS, ownValue: false, wrote: KEEP_FOREVER_DAYS });
      assert.equal(valueOf(readFileSync(file, 'utf8')), KEEP_FOREVER_DAYS);
      assert.deepEqual(JSON.parse(readFileSync(written, 'utf8')), { written: KEEP_FOREVER_DAYS });
      assert.deepEqual(await applyRetention(dir, 0, written), { days: KEEP_FOREVER_DAYS, ownValue: false });
      assert.equal((await applyRetention(dir, 90, written)).wrote, 90);
      assert.deepEqual(JSON.parse(readFileSync(written, 'utf8')), { written: 90 });
      writeFileSync(file, '{ "cleanupPeriodDays": 7 }');
      assert.deepEqual(await applyRetention(dir, 30, written), { days: 7, ownValue: true });
      assert.equal(valueOf(readFileSync(file, 'utf8')), 7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
