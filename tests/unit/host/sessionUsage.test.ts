import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseUsageLines, readUsageFile, UsageIndex, type UsageCall } from '../../../src/host/main/sessionUsage';
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
    const calls = new Map<string, UsageCall>();
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
      calls,
    );
    assert.equal(calls.size, 1);
    assert.deepEqual(calls.get('msg-ok'), { at: AT, model: 'deepseek-flash', input: 100, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test('the last line of a reply replaces the earlier ones, and the first line sets the folder', () => {
    const calls = new Map<string, UsageCall>();
    const cwd = parseUsageLines(
      [
        callLine(ID_A, { id: 'msg-1', model: 'deepseek-flash', input: 100, output: 20, cacheRead: 300 }),
        callLine(ID_A, { id: 'msg-1', model: 'deepseek-flash', input: 5, output: 6 }),
        callLine(ID_A, { id: 'msg-2', model: 'deepseek-flash', input: 7, cwd: OTHER_FOLDER }),
      ].join('\n'),
      calls,
    );
    assert.equal(cwd, FOLDER);
    assert.equal(calls.size, 2);
    assert.deepEqual(calls.get('msg-1'), { at: AT, model: 'deepseek-flash', input: 5, output: 6, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(calls.get('msg-2'), { at: AT, model: 'deepseek-flash', input: 7, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test('negative or non-numeric token counts become zero', () => {
    const calls = new Map<string, UsageCall>();
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
      calls,
    );
    assert.deepEqual(calls.get('msg-1'), { at: AT, model: 'deepseek-flash', input: 0, output: 0, cacheRead: 10, cacheWrite: 0 });
  });

  test('a synthetic reply is not counted', () => {
    const calls = new Map<string, UsageCall>();
    parseUsageLines([callLine(ID_A, { id: 'msg-1', model: '<synthetic>', input: 10 })].join('\n'), calls);
    assert.equal(calls.size, 0);
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
      assert.equal(first.calls.size, 1);
      assert.equal(first.offset, first.size);

      assert.equal(await readUsageFile(file, first), first);

      appendFileSync(file, callLine(ID_A, { id: 'msg-2', model: 'deepseek-flash', input: 200 }) + '\n');
      const later = new Date(Date.now() + 60_000);
      utimesSync(file, later, later);
      const second = await readUsageFile(file, first);
      assert.ok(second);
      assert.notEqual(second, first);
      assert.equal(second.calls.size, 2);
      assert.ok(second.calls.has('msg-1'));
      assert.ok(second.calls.has('msg-2'));
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
      assert.equal(partial.calls.size, 1);
      assert.ok(!partial.calls.has('msg-2'));
      assert.ok(partial.offset < partial.size);

      appendFileSync(file, '\n');
      utimesSync(file, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
      const done = await readUsageFile(file, partial);
      assert.ok(done);
      assert.equal(done.calls.size, 2);
      assert.ok(done.calls.has('msg-2'));
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
      assert.equal(first.calls.size, 2);

      writeFileSync(file, callLine(ID_A, { id: 'msg-3', model: 'deepseek-flash', input: 300 }) + '\n');
      utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      const second = await readUsageFile(file, first);
      assert.ok(second);
      assert.equal(second.calls.size, 1);
      assert.ok(second.calls.has('msg-3'));
      assert.ok(!second.calls.has('msg-1'));
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
      assert.equal(first.cwd, cwd);

      appendFileSync(file, callLine(ID_A, { id: 'msg-2', model: 'deepseek-flash', input: 200, cwd }) + '\n');
      utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      const second = await readUsageFile(file, first);
      assert.ok(second);
      assert.equal(second.calls.size, 2);
      assert.equal(second.cwd, cwd);
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
