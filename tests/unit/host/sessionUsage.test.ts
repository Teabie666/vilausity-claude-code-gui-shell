import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { newUsageLines, parseUsageLines, readUsageFile, UsageIndex } from '../../../src/host/main/sessionUsage';
import { parseTags, SessionTagReader, SessionTagWriter, tagLine } from '../../../src/host/main/sessionProviders';
import type { AttributedProvider } from '../../../src/platform/usage';

const FOLDER = 'C:\\work\\shop';
const OTHER_FOLDER = 'C:\\work\\other';
const TIMESTAMP = '2026-10-13T08:00:00.000Z';
const AT = Date.parse(TIMESTAMP);

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const subscription: AttributedProvider = { id: 'subscription', type: 'subscription', models: [] };
const deepseek: AttributedProvider = { id: 'deepseek', type: 'compatible', models: ['deepseek-flash'] };
const providers: AttributedProvider[] = [subscription, deepseek];

const line = (value: unknown): string => JSON.stringify(value);

interface CallLine {
  readonly id: string;
  readonly model: string;
  readonly at?: string;
  readonly cwd?: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** One assistant transcript line, as Claude Code writes a reply's content block. */
const callLine = (sessionId: string, opts: CallLine): string =>
  line({
    type: 'assistant',
    cwd: opts.cwd ?? FOLDER,
    sessionId,
    timestamp: opts.at ?? TIMESTAMP,
    message: {
      id: opts.id,
      model: opts.model,
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheWrite ?? 0,
      },
    },
  });

/** Writes a session transcript (and its subagent files) under `projectsDir/folder/`. */
function writeSession(root: string, folder: string, id: string, lines: readonly string[], subagents: readonly string[] = []): void {
  const dir = path.join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');
  for (const [index, content] of subagents.entries()) {
    const subagentDir = path.join(dir, id, 'subagents');
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(path.join(subagentDir, `agent-${index + 1}.jsonl`), content + '\n');
  }
}

describe('parseUsageLines', () => {
  test('counts only assistant lines with a model, a usage and a valid timestamp', () => {
    const lines = newUsageLines();
    const calls = lines.calls;
    parseUsageLines(
      [
        callLine(ID_A, { id: 'msg-ok', model: 'deepseek-flash', input: 100 }),
        line({ type: 'user', cwd: FOLDER, message: { role: 'user', content: 'hi' } }),
        '{"type":"assistant","message":{"id":"msg-bad","model":"deepseek-flash","usage":{"input_tokens":1}',
        line({ type: 'assistant', cwd: FOLDER, timestamp: TIMESTAMP, message: { model: 'deepseek-flash', usage: { input_tokens: 1 } } }),
        line({ type: 'assistant', cwd: FOLDER, timestamp: TIMESTAMP, message: { id: 'msg-no-model', usage: { input_tokens: 1 } } }),
        line({
          type: 'assistant',
          cwd: FOLDER,
          timestamp: TIMESTAMP,
          message: { id: 'msg-no-usage', model: 'deepseek-flash', usage: 'x' },
        }),
        line({ type: 'assistant', cwd: FOLDER, message: { id: 'msg-no-time', model: 'deepseek-flash', usage: { input_tokens: 1 } } }),
      ].join('\n'),
      lines,
    );
    assert.equal(calls.size, 1);
    assert.deepEqual(calls.get('msg-ok'), {
      id: 'msg-ok',
      at: AT,
      model: 'deepseek-flash',
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test('the last line of a reply replaces the earlier ones, and the first line sets the folder', () => {
    const lines = newUsageLines();
    const calls = lines.calls;
    parseUsageLines(
      [
        callLine(ID_A, { id: 'msg-1', model: 'deepseek-flash', input: 100, output: 20, cacheRead: 300 }),
        callLine(ID_A, { id: 'msg-1', model: 'deepseek-flash', input: 5, output: 6 }),
        callLine(ID_A, { id: 'msg-2', model: 'deepseek-flash', input: 7, cwd: OTHER_FOLDER }),
      ].join('\n'),
      lines,
    );
    assert.equal(lines.cwd, FOLDER);
    assert.equal(calls.size, 2);
    assert.deepEqual(calls.get('msg-1'), {
      id: 'msg-1',
      at: AT,
      model: 'deepseek-flash',
      input: 5,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.deepEqual(calls.get('msg-2'), {
      id: 'msg-2',
      at: AT,
      model: 'deepseek-flash',
      input: 7,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test('negative or non-numeric token counts become zero', () => {
    const lines = newUsageLines();
    const calls = lines.calls;
    parseUsageLines(
      [
        line({
          type: 'assistant',
          cwd: FOLDER,
          timestamp: TIMESTAMP,
          message: {
            id: 'msg-1',
            model: 'deepseek-flash',
            usage: { input_tokens: -5, output_tokens: '20', cache_read_input_tokens: 10, cache_creation_input_tokens: null },
          },
        }),
      ].join('\n'),
      lines,
    );
    assert.deepEqual(calls.get('msg-1'), {
      id: 'msg-1',
      at: AT,
      model: 'deepseek-flash',
      input: 0,
      output: 0,
      cacheRead: 10,
      cacheWrite: 0,
    });
  });

  test('a synthetic reply is not counted', () => {
    const lines = newUsageLines();
    const calls = lines.calls;
    parseUsageLines([callLine(ID_A, { id: 'msg-1', model: '<synthetic>', input: 10 })].join('\n'), lines);
    assert.equal(calls.size, 0);
  });

  test("keeps Claude Code's own counts (cost-state lines), at the time of the line before, by model", () => {
    const lines = newUsageLines();
    const costState = (models: Record<string, [number, number, number]>) =>
      line({
        type: 'cost-state',
        sessionId: ID_A,
        startTime: 0,
        totalDuration: 5,
        modelUsage: Object.fromEntries(
          Object.entries(models).map(([model, [input, output, cacheRead]]) => [
            model,
            { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: 0, costUSD: 1 },
          ]),
        ),
      });
    parseUsageLines(
      [
        // None before the first line with a time: when it was written is not known.
        costState({ 'deepseek-flash': [1, 1, 1] }),
        callLine(ID_A, { id: 'msg-1', model: 'deepseek-flash', input: 100, at: '2026-10-13T08:00:00.000Z' }),
        // A tool result with a timestamp of its own, after the line's (as Claude Code writes them).
        line({ type: 'user', timestamp: '2026-10-13T08:01:00.000Z', toolUseResult: { timestamp: '2027-01-01T00:00:00.000Z' } }),
        // A line written out of order does not take the time back.
        line({ type: 'system', subtype: 'turn_duration', timestamp: '2026-10-13T07:00:00.000Z' }),
        costState({ 'deepseek-flash[1m]': [100, 50, 0], 'deepseek-flash': [10, 5, 0], 'claude-haiku-4-5': [3, 2, 0] }),
      ].join('\n'),
      lines,
    );
    parseUsageLines(costState({ 'deepseek-flash': [200, 60, 0] }), lines);
    assert.deepEqual(lines.snapshots, [
      {
        at: Date.parse('2026-10-13T08:01:00.000Z'),
        models: {
          'deepseek-flash': { input: 110, output: 55, cacheRead: 0, cacheWrite: 0 },
          'claude-haiku-4-5': { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      },
      { at: Date.parse('2026-10-13T08:01:00.000Z'), models: { 'deepseek-flash': { input: 200, output: 60, cacheRead: 0, cacheWrite: 0 } } },
    ]);
  });

  test('keeps the model a call asked for and when the counts began (startTime), which stands in for a time not known', () => {
    const lines = newUsageLines();
    const started = Date.parse('2026-10-13T07:00:00.000Z');
    parseUsageLines(
      [
        line({ type: 'cost-state', sessionId: ID_A, startTime: started, totalDuration: 5, modelUsage: {} }),
        line({
          type: 'assistant',
          requestedModel: 'deepseek-flash[1m]',
          timestamp: TIMESTAMP,
          message: { id: 'msg-1', model: 'deepseek-flash', usage: { input_tokens: 1 } },
        }),
        line({ type: 'cost-state', sessionId: ID_A, startTime: started, totalDuration: 9, modelUsage: {} }),
      ].join('\n'),
      lines,
    );
    assert.equal(lines.calls.get('msg-1')?.requested, 'deepseek-flash[1m]');
    assert.deepEqual(lines.snapshots, [
      { at: started, since: started, models: {} },
      { at: AT, since: started, models: {} },
    ]);
  });
});

describe('readUsageFile', () => {
  test('a file that does not exist reads as no state', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-usage-'));
    try {
      assert.equal(await readUsageFile(path.join(dir, 'none.jsonl'), undefined), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reads the whole file, then only what was appended, returning an unchanged file as-is', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-usage-'));
    try {
      const file = path.join(dir, 'a.jsonl');
      writeFileSync(file, callLine(ID_A, { id: 'msg-1', model: 'deepseek-flash', input: 100 }) + '\n');
      const first = await readUsageFile(file, undefined);
      assert.ok(first);
      assert.equal(first.lines.calls.size, 1);
      assert.equal(first.offset, first.size);

      assert.equal(await readUsageFile(file, first), first);

      appendFileSync(file, callLine(ID_A, { id: 'msg-2', model: 'deepseek-flash', input: 200 }) + '\n');
      const later = new Date(Date.now() + 60_000);
      utimesSync(file, later, later);
      const second = await readUsageFile(file, first);
      assert.ok(second);
      assert.notEqual(second, first);
      assert.equal(second.lines.calls.size, 2);
      assert.ok(second.lines.calls.has('msg-1'));
      assert.ok(second.lines.calls.has('msg-2'));
      assert.equal(second.offset, second.size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a last line still being written waits for its newline', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-usage-'));
    try {
      const file = path.join(dir, 'a.jsonl');
      writeFileSync(file, callLine(ID_A, { id: 'msg-1', model: 'deepseek-flash', input: 100 }) + '\n');
      const first = await readUsageFile(file, undefined);
      assert.ok(first);

      appendFileSync(file, callLine(ID_A, { id: 'msg-2', model: 'deepseek-flash', input: 200 }));
      utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      const partial = await readUsageFile(file, first);
      assert.ok(partial);
      assert.equal(partial.lines.calls.size, 1);
      assert.ok(!partial.lines.calls.has('msg-2'));
      assert.ok(partial.offset < partial.size);

      appendFileSync(file, '\n');
      utimesSync(file, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
      const done = await readUsageFile(file, partial);
      assert.ok(done);
      assert.equal(done.lines.calls.size, 2);
      assert.ok(done.lines.calls.has('msg-2'));
      assert.equal(done.offset, done.size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a rewritten, shorter file is read again from the start', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-usage-'));
    try {
      const file = path.join(dir, 'a.jsonl');
      writeFileSync(
        file,
        callLine(ID_A, { id: 'msg-1', model: 'deepseek-flash', input: 100 }) +
          '\n' +
          callLine(ID_A, { id: 'msg-2', model: 'deepseek-flash', input: 200 }) +
          '\n',
      );
      const first = await readUsageFile(file, undefined);
      assert.ok(first);
      assert.equal(first.lines.calls.size, 2);

      writeFileSync(file, callLine(ID_A, { id: 'msg-3', model: 'deepseek-flash', input: 300 }) + '\n');
      utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      const second = await readUsageFile(file, first);
      assert.ok(second);
      assert.equal(second.lines.calls.size, 1);
      assert.ok(second.lines.calls.has('msg-3'));
      assert.ok(!second.lines.calls.has('msg-1'));
      assert.equal(second.offset, second.size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps reading correctly across multi-byte characters in the cwd', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-usage-'));
    try {
      const file = path.join(dir, 'a.jsonl');
      const cwd = 'C:\\work\\商店';
      writeFileSync(file, callLine(ID_A, { id: 'msg-1', model: 'deepseek-flash', input: 100, cwd }) + '\n');
      const first = await readUsageFile(file, undefined);
      assert.ok(first);
      assert.equal(first.lines.cwd, cwd);

      appendFileSync(file, callLine(ID_A, { id: 'msg-2', model: 'deepseek-flash', input: 200, cwd }) + '\n');
      utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      const second = await readUsageFile(file, first);
      assert.ok(second);
      assert.equal(second.lines.calls.size, 2);
      assert.equal(second.lines.cwd, cwd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('UsageIndex', () => {
  const A_MAIN = callLine(ID_A, { id: 'msg-a-1', model: 'deepseek-flash', input: 100, output: 20, cacheRead: 300 });
  const A_SUB = callLine(ID_A, { id: 'msg-a-2', model: 'deepseek-flash', input: 50, output: 10 });
  const B_MAIN = callLine(ID_B, { id: 'msg-b-1', model: 'claude-opus-5-5', input: 5, output: 5 });
  const C_MAIN = callLine(ID_C, { id: 'msg-c-1', model: 'deepseek-flash', input: 7, output: 3, cwd: OTHER_FOLDER });

  function makeProject(): { root: string; tagsFile: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-usage-'));
    writeSession(root, 'shop', ID_A, [A_MAIN], [A_SUB]);
    writeSession(root, 'shop', ID_B, [B_MAIN]);
    writeSession(root, 'other', ID_C, [C_MAIN]);
    return { root, tagsFile: path.join(root, 'session-providers.jsonl') };
  }

  test('sums the session, folder and all scopes, and answers models, lastProvider and sessionProviders', async () => {
    const { root, tagsFile } = makeProject();
    try {
      const index = new UsageIndex(root, tagsFile);
      assert.deepEqual(await index.answer({ kind: 'summary' as const, providers, provider: 'deepseek', sessionId: ID_A, folder: FOLDER }), {
        session: { 'deepseek-flash': { input: 150, output: 30, cacheRead: 300, cacheWrite: 0, calls: 2 } },
        folder: { 'deepseek-flash': { input: 150, output: 30, cacheRead: 300, cacheWrite: 0, calls: 2 } },
        all: { 'deepseek-flash': { input: 157, output: 33, cacheRead: 300, cacheWrite: 0, calls: 3 } },
      });
      // The folder matches regardless of case or separator direction.
      assert.deepEqual(await index.answer({ kind: 'summary' as const, providers, provider: 'deepseek', folder: 'c:/work/SHOP' }), {
        session: {},
        folder: { 'deepseek-flash': { input: 150, output: 30, cacheRead: 300, cacheWrite: 0, calls: 2 } },
        all: { 'deepseek-flash': { input: 157, output: 33, cacheRead: 300, cacheWrite: 0, calls: 3 } },
      });
      assert.deepEqual(await index.answer({ kind: 'models' as const, providers, provider: 'deepseek' }), ['deepseek-flash']);
      assert.deepEqual(await index.answer({ kind: 'models' as const, providers, provider: 'subscription' }), ['claude-opus-5-5']);
      assert.equal(await index.answer({ kind: 'lastProvider' as const, providers, sessionId: ID_A }), 'deepseek');
      assert.equal(await index.answer({ kind: 'lastProvider' as const, providers, sessionId: ID_B }), 'subscription');
      assert.equal(await index.answer({ kind: 'lastProvider' as const, providers, sessionId: ID_D }), undefined);
      assert.deepEqual(await index.answer({ kind: 'sessionProviders' as const, providers }), {
        [ID_A]: 'deepseek',
        [ID_B]: 'subscription',
        [ID_C]: 'deepseek',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a tag overrides the model, and an untagged session with two matching providers is ambiguous', async () => {
    const { root, tagsFile } = makeProject();
    try {
      const index = new UsageIndex(root, tagsFile);
      const taggedProviders: AttributedProvider[] = [...providers, { id: 'deepseek-work', type: 'compatible', models: ['deepseek-flash'] }];
      const writer = new SessionTagWriter(tagsFile);
      await writer.add(ID_C, { provider: 'deepseek-work', name: 'Work', at: 0 });

      assert.equal(await index.answer({ kind: 'lastProvider' as const, providers: taggedProviders, sessionId: ID_C }), 'deepseek-work');
      assert.equal(await index.answer({ kind: 'lastProvider' as const, providers: taggedProviders, sessionId: ID_A }), undefined);
      assert.deepEqual(await index.answer({ kind: 'sessionProviders' as const, providers: taggedProviders }), {
        [ID_B]: 'subscription',
        [ID_C]: 'deepseek-work',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a deleted transcript disappears from the scopes for a new index', async () => {
    const { root, tagsFile } = makeProject();
    try {
      const index = new UsageIndex(root, tagsFile);
      const before = await index.answer({ kind: 'summary' as const, providers, provider: 'deepseek' });
      assert.equal(before.all['deepseek-flash']?.input, 157);

      rmSync(path.join(root, 'other', `${ID_C}.jsonl`));
      // A new index re-reads the folders without waiting out the rescan throttle.
      const after = await new UsageIndex(root, tagsFile).answer({ kind: 'summary' as const, providers, provider: 'deepseek' });
      assert.deepEqual(after.all, { 'deepseek-flash': { input: 150, output: 30, cacheRead: 300, cacheWrite: 0, calls: 2 } });
      assert.deepEqual(after.session, {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the ledger keeps a deleted transcript's calls: the total counts them, the scopes do not", async () => {
    const { root, tagsFile } = makeProject();
    const ledgerFile = path.join(root, 'usage-ledger.jsonl');
    try {
      const index = new UsageIndex(root, tagsFile, ledgerFile);
      const total = { kind: 'total' as const, providers, provider: 'deepseek' };
      assert.equal((await index.answer(total))['deepseek-flash']?.input, 157);

      rmSync(path.join(root, 'other', `${ID_C}.jsonl`));
      await index.answer({ kind: 'sync' as const });
      const summary = await index.answer({ kind: 'summary' as const, providers, provider: 'deepseek' });
      assert.equal(summary.all['deepseek-flash']?.input, 150);
      assert.equal((await index.answer(total))['deepseek-flash']?.input, 157);
      // Kept on disk: another index (the next start) has it too.
      assert.deepEqual((await new UsageIndex(root, tagsFile, ledgerFile).answer(total))['deepseek-flash'], {
        input: 157,
        output: 33,
        cacheRead: 300,
        cacheWrite: 0,
        calls: 3,
      });
      // Read once more, the transcripts add nothing to the ledger.
      const lines = readFileSync(ledgerFile, 'utf8').trim().split('\n').length;
      await new UsageIndex(root, tagsFile, ledgerFile).answer({ kind: 'sync' as const });
      assert.equal(readFileSync(ledgerFile, 'utf8').trim().split('\n').length, lines);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sync reads a transcript that grew a moment ago, and its new calls go into the ledger', async () => {
    const { root, tagsFile } = makeProject();
    const ledgerFile = path.join(root, 'usage-ledger.jsonl');
    try {
      const index = new UsageIndex(root, tagsFile, ledgerFile);
      const summary = { kind: 'summary' as const, providers, provider: 'deepseek' };
      assert.equal((await index.answer(summary)).all['deepseek-flash']?.calls, 3);
      appendFileSync(path.join(root, 'shop', `${ID_A}.jsonl`), callLine(ID_A, { id: 'msg-a-3', model: 'deepseek-flash', input: 1 }) + '\n');
      // Within the rescan throttle: what was read.
      assert.equal((await index.answer(summary)).all['deepseek-flash']?.calls, 3);
      await index.answer({ kind: 'sync' as const });
      assert.equal((await index.answer(summary)).all['deepseek-flash']?.calls, 4);
      assert.ok(readFileSync(ledgerFile, 'utf8').includes('msg-a-3'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session: one session's tokens by provider, priced", async () => {
    const { root, tagsFile } = makeProject();
    try {
      const index = new UsageIndex(root, tagsFile);
      const pricing = { deepseek: { currency: 'CNY' as const, models: { 'deepseek-flash': { input: 1, output: 2, cacheRead: 0.1 } } } };
      const result = await index.answer({ kind: 'session' as const, providers, sessionId: ID_A, pricing });
      assert.deepEqual(Object.keys(result), ['deepseek']);
      const flash = result.deepseek?.['deepseek-flash'];
      assert.equal(flash?.calls, 2);
      assert.ok(Math.abs((flash?.cost ?? 0) - (150 * 1 + 30 * 2 + 300 * 0.1) / 1e6) < 1e-12);
      assert.deepEqual(await index.answer({ kind: 'session' as const, providers, sessionId: ID_D, pricing }), {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a forked conversation counts only its own calls: the copied ones belong to the older transcript', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-usage-'));
    try {
      const original = callLine(ID_B, { id: 'msg-old', model: 'deepseek-flash', input: 100 });
      writeSession(root, 'shop', ID_B, [original]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Listed first (its id sorts first), made later: the fork.
      writeSession(root, 'shop', ID_A, [original, callLine(ID_A, { id: 'msg-new', model: 'deepseek-flash', input: 10 })]);
      const index = new UsageIndex(root, path.join(root, 'tags.jsonl'));
      const fork = await index.answer({ kind: 'summary' as const, providers, provider: 'deepseek', sessionId: ID_A });
      assert.equal(fork.session['deepseek-flash']?.input, 10);
      assert.equal(fork.all['deepseek-flash']?.input, 110);
      const old = await index.answer({ kind: 'summary' as const, providers, provider: 'deepseek', sessionId: ID_B });
      assert.equal(old.session['deepseek-flash']?.input, 100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Claude Code's own counts add the calls the transcripts leave out, its subagents' calls counted in", async () => {
    const { root, tagsFile } = makeProject();
    const ledgerFile = path.join(root, 'usage-ledger.jsonl');
    try {
      // Session A's calls (its subagent's too): 150 in, 30 out, 300 cache reads. Its process
      // counted 1000 more output (compacting the conversation) and a title's 20 in, 5 out.
      appendFileSync(
        path.join(root, 'shop', `${ID_A}.jsonl`),
        line({
          type: 'cost-state',
          sessionId: ID_A,
          startTime: 0,
          totalDuration: 1,
          modelUsage: {
            'deepseek-flash[1m]': { inputTokens: 150, outputTokens: 1030, cacheReadInputTokens: 300, cacheCreationInputTokens: 0 },
            'deepseek-flash': { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          },
        }) + '\n',
      );
      const index = new UsageIndex(root, tagsFile, ledgerFile);
      const summary = await index.answer({ kind: 'summary' as const, providers, provider: 'deepseek', sessionId: ID_A });
      assert.deepEqual(summary.session['deepseek-flash'], {
        input: 170,
        output: 1035,
        cacheRead: 300,
        cacheWrite: 0,
        calls: 2,
        unrecorded: { input: 20, output: 1005, cacheRead: 0, cacheWrite: 0 },
      });
      // Kept in the ledger with the rest.
      assert.equal((await index.answer({ kind: 'total' as const, providers, provider: 'deepseek' }))['deepseek-flash']?.output, 1038);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a process killed before it wrote its count: the next one's count is set against its own calls only", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-usage-'));
    const ledgerFile = path.join(root, 'usage-ledger.jsonl');
    try {
      const asked = (id: string, at: string, input: number, output: number, cacheRead: number): string =>
        line({
          type: 'assistant',
          requestedModel: 'deepseek-v4-pro',
          cwd: FOLDER,
          sessionId: ID_A,
          timestamp: at,
          message: {
            id,
            model: 'deepseek-v4-pro',
            usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
          },
        });
      const counts = (modelUsage: Record<string, [number, number, number]>): string =>
        line({
          type: 'cost-state',
          sessionId: ID_A,
          // The process after the killed one started at 08:02:24.
          startTime: Date.parse('2026-10-14T08:02:24.845Z'),
          totalDuration: 1,
          modelUsage: Object.fromEntries(
            Object.entries(modelUsage).map(([model, [input, output, cacheRead]]) => [
              model,
              {
                inputTokens: input,
                outputTokens: output,
                cacheReadInputTokens: cacheRead,
                cacheCreationInputTokens: 0,
                webSearchRequests: 0,
              },
            ]),
          ),
        });
      // As a DeepSeek session went (2.1.299): the first process answered once and was killed with the
      // app; the next one counted from nothing, its eight web searches (flash) among its calls.
      writeSession(root, 'shop', ID_A, [
        asked('msg-1', '2026-10-14T07:23:44.897Z', 49949, 54, 0),
        counts({}),
        asked('msg-2', '2026-10-14T08:05:12.551Z', 134, 1218, 49920),
        counts({ 'deepseek-v4-pro': [134, 1218, 49920], 'deepseek-flash[1m]': [158170, 8402, 3968] }),
      ]);
      // What an earlier reckoning put in the ledger: less for this count, and some for another.
      writeFileSync(
        ledgerFile,
        `${line({ s: ID_A, f: FOLDER, c: [[`${ID_A}:unrecorded:1:deepseek-flash`, 1, 'deepseek-flash', 108221, 8348, 3968, 0, 0]] })}\n` +
          `${line({ s: ID_A, f: FOLDER, c: [[`${ID_A}:unrecorded:0:deepseek-flash`, 1, 'deepseek-flash', 5, 5, 5, 0, 0]] })}\n`,
      );
      const both: AttributedProvider = { id: 'deepseek', type: 'compatible', models: ['deepseek-flash', 'deepseek-v4-pro'] };
      const index = new UsageIndex(root, path.join(root, 'tags.jsonl'), ledgerFile);
      const summary = await index.answer({
        kind: 'summary' as const,
        providers: [subscription, both],
        provider: 'deepseek',
        sessionId: ID_A,
      });
      assert.deepEqual(summary.session['deepseek-flash'], {
        input: 158170,
        output: 8402,
        cacheRead: 3968,
        cacheWrite: 0,
        calls: 0,
        unrecorded: { input: 158170, output: 8402, cacheRead: 3968, cacheWrite: 0 },
      });
      assert.equal(summary.session['deepseek-v4-pro']?.input, 49949 + 134);
      // The ledger has the new figures over the old, as a made-up call (not one more call).
      const total = await new UsageIndex(root, path.join(root, 'tags.jsonl'), ledgerFile).answer({
        kind: 'total' as const,
        providers: [subscription, both],
        provider: 'deepseek',
      });
      assert.deepEqual(total['deepseek-flash'], summary.session['deepseek-flash']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('tagLine', () => {
  test('writes one JSON line with s, p, n and t', () => {
    assert.equal(
      tagLine(ID_A, { provider: 'deepseek', name: 'DeepSeek', at: 100 }),
      `${line({ s: ID_A, p: 'deepseek', n: 'DeepSeek', t: 100 })}\n`,
    );
  });
});

describe('parseTags', () => {
  test('drops broken lines and sorts each session oldest first', () => {
    const text = [
      'not json',
      line({ s: 'not-a-uuid', p: 'deepseek', n: 'x', t: 1 }),
      line({ s: ID_A, p: '', n: 'x', t: 1 }),
      line({ s: ID_A, p: 'deepseek', n: 'x', t: '1' }),
      line({ s: 123, p: 'deepseek', n: 'x', t: 1 }),
      line({ s: ID_A, p: 'deepseek', n: 5, t: 2 }),
      line({ s: ID_A, p: 'deepseek', n: 'late', t: 200 }),
      line({ s: ID_A, p: 'deepseek', n: 'early', t: 100 }),
    ].join('\n');
    assert.deepEqual(parseTags(text).get(ID_A), [
      { provider: 'deepseek', name: '', at: 2 },
      { provider: 'deepseek', name: 'early', at: 100 },
      { provider: 'deepseek', name: 'late', at: 200 },
    ]);
    assert.deepEqual(parseTags(tagLine(ID_A, { provider: 'deepseek', name: 'DeepSeek', at: 100 })).get(ID_A), [
      { provider: 'deepseek', name: 'DeepSeek', at: 100 },
    ]);
  });
});

describe('SessionTagWriter', () => {
  test('add makes the directory and appends one line per add', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-usage-'));
    try {
      const tagsFile = path.join(root, 'deep', 'nested', 'tags.jsonl');
      const writer = new SessionTagWriter(tagsFile);
      await writer.add(ID_A, { provider: 'deepseek', name: 'DeepSeek', at: 100 });
      await writer.add(ID_B, { provider: 'subscription', name: '', at: 200 });

      const lines = readFileSync(tagsFile, 'utf8').trimEnd().split('\n');
      assert.equal(lines.length, 2);
      assert.deepEqual(
        parseTags(readFileSync(tagsFile, 'utf8')),
        new Map([
          [ID_A, [{ provider: 'deepseek', name: 'DeepSeek', at: 100 }]],
          [ID_B, [{ provider: 'subscription', name: '', at: 200 }]],
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('SessionTagReader', () => {
  test('returns an empty map for a missing file, reuses an unchanged one, and sees appends', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-usage-'));
    try {
      const tagsFile = path.join(root, 'tags.jsonl');
      const reader = new SessionTagReader(tagsFile);
      assert.deepEqual(await reader.read(), new Map());

      writeFileSync(tagsFile, tagLine(ID_A, { provider: 'deepseek', name: 'DeepSeek', at: 100 }));
      utimesSync(tagsFile, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      const first = await reader.read();
      assert.deepEqual([...first.keys()], [ID_A]);
      assert.equal(await reader.read(), first);

      appendFileSync(tagsFile, tagLine(ID_B, { provider: 'subscription', name: '', at: 200 }));
      utimesSync(tagsFile, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
      const second = await reader.read();
      assert.deepEqual([...second.keys()], [ID_A, ID_B]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
