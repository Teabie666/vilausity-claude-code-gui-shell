import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyRetention, KEEP_FOREVER_DAYS, retentionEdit } from '../../../src/host/main/claudeRetention';

const valueOf = (text: string | undefined): unknown => (text === undefined ? undefined : JSON.parse(text).cleanupPeriodDays);

describe('retentionEdit', () => {
  test('sets the period when it is not set, in a file or none, keeping the rest and its comments', () => {
    assert.equal(valueOf(retentionEdit(undefined, true)), KEEP_FOREVER_DAYS);
    assert.equal(valueOf(retentionEdit('', true)), KEEP_FOREVER_DAYS);
    const edited = retentionEdit('{\n  // mine\n  "model": "fable",\n  "theme": "dark"\n}\n', true);
    assert.ok(edited?.includes('// mine'));
    assert.ok(edited?.includes('"model": "fable"'));
    assert.ok(edited?.includes(`"cleanupPeriodDays": ${KEEP_FOREVER_DAYS}`));
  });

  test("leaves a period of the user's own, and takes out only its own value when turned off", () => {
    assert.equal(retentionEdit('{ "cleanupPeriodDays": 90 }', true), undefined);
    assert.equal(retentionEdit(`{ "cleanupPeriodDays": ${KEEP_FOREVER_DAYS} }`, true), undefined);
    assert.equal(retentionEdit('{ "cleanupPeriodDays": 90 }', false), undefined);
    assert.equal(retentionEdit('{ "model": "fable" }', false), undefined);
    const removed = retentionEdit(`{\n  "model": "fable",\n  "cleanupPeriodDays": ${KEEP_FOREVER_DAYS}\n}\n`, false);
    assert.deepEqual(JSON.parse(removed ?? ''), { model: 'fable' });
  });

  test('a file that is not a JSON object is left as it is', () => {
    assert.equal(retentionEdit('{ "model": ', true), undefined);
    assert.equal(retentionEdit('[1, 2]', true), undefined);
    assert.equal(retentionEdit('"text"', true), undefined);
  });

  test("keeps the file's line ends", () => {
    const edited = retentionEdit('{\r\n  "model": "fable"\r\n}\r\n', true);
    assert.ok(edited?.includes('\r\n'));
    assert.ok(!edited?.replace(/\r\n/g, '').includes('\n'));
  });
});

describe('applyRetention', () => {
  test('creates the setting, then has nothing to do; turned off it removes it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-retention-'));
    const file = path.join(dir, 'settings.json');
    try {
      assert.equal(await applyRetention(dir, true), 'set');
      assert.equal(valueOf(readFileSync(file, 'utf8')), KEEP_FOREVER_DAYS);
      assert.equal(await applyRetention(dir, true), undefined);
      assert.equal(await applyRetention(dir, false), 'removed');
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
      writeFileSync(file, '{ "cleanupPeriodDays": 7 }');
      assert.equal(await applyRetention(dir, true), undefined);
      assert.equal(valueOf(readFileSync(file, 'utf8')), 7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
