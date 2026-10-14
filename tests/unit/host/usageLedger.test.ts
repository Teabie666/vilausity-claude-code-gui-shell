import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ledgerLine, parseLedger, UsageLedger, type LedgerEntry } from '../../../src/host/main/usageLedger';
import type { SessionUsage, UsageCall } from '../../../src/platform/usage';

const FOLDER = 'C:\\work\\shop';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const call = (id: string, input: number, extra: Partial<UsageCall> = {}): UsageCall => ({
  id,
  at: 1000,
  model: 'deepseek-flash',
  input,
  output: 2,
  cacheRead: 3,
  cacheWrite: 0,
  ...extra,
});

function tempLedger(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-ledger-'));
  return { dir, file: path.join(dir, 'usage-ledger.jsonl') };
}

const lineCount = (file: string): number => readFileSync(file, 'utf8').trim().split('\n').length;

describe('ledgerLine and parseLedger', () => {
  test('read back what they write, thinking and the folder included', () => {
    const entries = new Map<string, LedgerEntry>();
    parseLedger(ledgerLine({ sessionId: ID_A, folder: FOLDER }, [call('m1', 1, { thinking: true }), call('m2', 5)]), entries);
    assert.deepEqual(entries.get('m1'), { sessionId: ID_A, folder: FOLDER, call: call('m1', 1, { thinking: true }) });
    assert.deepEqual(entries.get('m2'), { sessionId: ID_A, folder: FOLDER, call: call('m2', 5) });
  });

  test('a broken line or row is left out, the rest kept; a later line wins', () => {
    const entries = new Map<string, LedgerEntry>();
    parseLedger(
      [
        '{"s":"' + ID_A + '","c":[["m1",1000,"deepseek-flash",1,2,3,0,0]]',
        JSON.stringify({
          s: ID_A,
          c: [['m2', 'not a time', 'deepseek-flash', 1, 2, 3, 0, 0], ['m3', 1000, '', 1], 'x', ['m4', 1000, 'deepseek-flash', -1, '2']],
        }),
        JSON.stringify({ c: [['m5', 1000, 'deepseek-flash', 1, 2, 3, 0, 0]] }),
        ledgerLine({ sessionId: ID_B, folder: undefined }, [call('m6', 1)]),
        ledgerLine({ sessionId: ID_B, folder: undefined }, [call('m6', 9)]),
      ].join('\n'),
      entries,
    );
    assert.deepEqual([...entries.keys()].sort(), ['m4', 'm6']);
    assert.deepEqual(entries.get('m4')?.call, {
      id: 'm4',
      at: 1000,
      model: 'deepseek-flash',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.equal(entries.get('m6')?.call.input, 9);
  });
});

describe('UsageLedger', () => {
  test('appends only calls it does not have, keeps them by session, and a new ledger reads them back', async () => {
    const { dir, file } = tempLedger();
    try {
      const ledger = new UsageLedger(file);
      const a: SessionUsage = { sessionId: ID_A, folder: FOLDER, calls: [call('m1', 1), call('m2', 2)] };
      await ledger.record([a]);
      await ledger.record([a]);
      assert.equal(lineCount(file), 1);
      await ledger.record([{ ...a, calls: [...a.calls, call('m3', 3)] }]);
      assert.equal(lineCount(file), 2);
      assert.deepEqual(await new UsageLedger(file).sessions(), [
        { sessionId: ID_A, folder: FOLDER, calls: [call('m1', 1), call('m2', 2), call('m3', 3)] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a call whose tokens changed is written again; a fork's copy of another session's call is not", async () => {
    const { dir, file } = tempLedger();
    try {
      const ledger = new UsageLedger(file);
      await ledger.record([{ sessionId: ID_A, folder: FOLDER, calls: [call('m1', 1)] }]);
      await ledger.record([{ sessionId: ID_B, folder: FOLDER, calls: [call('m1', 1, { at: 2000 }), call('m9', 9)] }]);
      await ledger.record([{ sessionId: ID_A, folder: FOLDER, calls: [call('m1', 7)] }]);
      assert.equal(lineCount(file), 3);
      const sessions = await new UsageLedger(file).sessions();
      assert.deepEqual(sessions.find((session) => session.sessionId === ID_A)?.calls, [call('m1', 7)]);
      assert.deepEqual(sessions.find((session) => session.sessionId === ID_B)?.calls, [call('m9', 9)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sees what the other instance appended, and does not add it again; a line still being written waits', async () => {
    const { dir, file } = tempLedger();
    try {
      const ledger = new UsageLedger(file);
      await ledger.record([{ sessionId: ID_A, folder: FOLDER, calls: [call('m1', 1)] }]);
      appendFileSync(file, ledgerLine({ sessionId: ID_B, folder: undefined }, [call('m2', 2)]));
      appendFileSync(file, '{"s":"' + ID_B + '","c":[["m3",1000,"deepseek-flash"');
      assert.deepEqual((await ledger.sessions()).map((session) => session.sessionId).sort(), [ID_A, ID_B]);
      await ledger.record([{ sessionId: ID_B, folder: undefined, calls: [call('m2', 2)] }]);
      // The other instance finishes its line.
      appendFileSync(file, ',4,5,6,0,0]]}\n');
      const calls = (await ledger.sessions()).flatMap((session) => session.calls.map((one) => one.id ?? '')).sort();
      assert.deepEqual(calls, ['m1', 'm2', 'm3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a made-up call its session no longer has goes to no tokens and out of the sessions; the others stay', async () => {
    const { dir, file } = tempLedger();
    try {
      const ledger = new UsageLedger(file);
      const madeUp = (index: number, input: number): UsageCall =>
        call(`${ID_A}:unrecorded:${index}:deepseek-flash`, input, { unrecorded: true });
      await ledger.record([
        { sessionId: ID_A, folder: FOLDER, calls: [call('m1', 1), madeUp(0, 5), madeUp(1, 7)] },
        { sessionId: ID_B, folder: FOLDER, calls: [call(`${ID_B}:unrecorded:0:deepseek-flash`, 9, { unrecorded: true })] },
      ]);
      // Worked out again: all of it in the second count. Session B's transcript is gone (not given).
      await ledger.record([{ sessionId: ID_A, folder: FOLDER, calls: [call('m1', 1), madeUp(1, 12)] }]);
      const sessions = await new UsageLedger(file).sessions();
      assert.deepEqual(sessions.find((session) => session.sessionId === ID_A)?.calls, [call('m1', 1), madeUp(1, 12)]);
      assert.deepEqual(sessions.find((session) => session.sessionId === ID_B)?.calls, [
        call(`${ID_B}:unrecorded:0:deepseek-flash`, 9, { unrecorded: true }),
      ]);
      // Nothing changed: nothing written.
      const lines = lineCount(file);
      await ledger.record([{ sessionId: ID_A, folder: FOLDER, calls: [call('m1', 1), madeUp(1, 12)] }]);
      assert.equal(lineCount(file), lines);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a ledger rewritten shorter is read again from the start; no file is no calls', async () => {
    const { dir, file } = tempLedger();
    try {
      const ledger = new UsageLedger(file);
      assert.deepEqual(await ledger.sessions(), []);
      await ledger.record([{ sessionId: ID_A, folder: FOLDER, calls: [call('m1', 1), call('m2', 2)] }]);
      writeFileSync(file, ledgerLine({ sessionId: ID_B, folder: undefined }, [call('m3', 3)]));
      assert.deepEqual(await ledger.sessions(), [{ sessionId: ID_B, folder: undefined, calls: [call('m3', 3)] }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
