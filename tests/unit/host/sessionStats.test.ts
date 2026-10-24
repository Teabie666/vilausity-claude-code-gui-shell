import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { newStatsLines, parseStatsLines, readStatsFile, StatsIndex, streaks } from '../../../src/host/main/sessionStats';

const FOLDER = 'C:\\work\\shop';
const OTHER_FOLDER = 'C:\\work\\other';
const TIMESTAMP = '2026-10-13T08:00:00.000Z';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const line = (value: unknown): string => JSON.stringify(value);

interface UserOpts {
  readonly at?: string;
  readonly cwd?: string;
  readonly content: string | readonly unknown[];
  readonly meta?: boolean;
  readonly sidechain?: boolean;
  readonly toolUseResult?: unknown;
}

const userLine = (sessionId: string, opts: UserOpts): string =>
  line({
    type: 'user',
    cwd: opts.cwd ?? FOLDER,
    sessionId,
    timestamp: opts.at ?? TIMESTAMP,
    message: { role: 'user', content: opts.content },
    ...(opts.meta ? { isMeta: true } : {}),
    ...(opts.sidechain ? { isSidechain: true } : {}),
    ...(opts.toolUseResult === undefined ? {} : { toolUseResult: opts.toolUseResult }),
  });

interface AssistantOpts {
  readonly id: string;
  readonly blocks: readonly Record<string, unknown>[];
  readonly model?: string;
  readonly at?: string;
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

const assistantLine = (sessionId: string, opts: AssistantOpts): string =>
  line({
    type: 'assistant',
    cwd: FOLDER,
    sessionId,
    timestamp: opts.at ?? TIMESTAMP,
    message: {
      id: opts.id,
      model: opts.model ?? 'deepseek-flash',
      content: opts.blocks,
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheWrite ?? 0,
      },
    },
  });

const text = (value: string): Record<string, unknown> => ({ type: 'text', text: value });
const thinking = (): Record<string, unknown> => ({ type: 'thinking', thinking: '...' });
const redactedThinking = (): Record<string, unknown> => ({ type: 'redacted_thinking', data: '...' });
const toolUse = (name: string): Record<string, unknown> => ({ type: 'tool_use', id: 'call-1', name, input: {} });

/** An Edit / MultiEdit result: `filePath` plus a `structuredPatch` whose lines are `+`/`-`/space prefixed. */
const editResult = (filePath: string, patchLines: readonly string[]): unknown => ({
  filePath,
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: patchLines.length, lines: patchLines }],
});

/** A Write result for a new file: no patch, the whole `content` is new. */
const createResult = (filePath: string, content: string): unknown => ({ type: 'create', filePath, content, structuredPatch: [] });

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

describe('parseStatsLines', () => {
  test('counts what the user typed, leaving out the context the IDE and the CLI add and tool results', () => {
    const lines = newStatsLines();
    parseStatsLines(
      [
        userLine(ID_A, { content: 'hello world' }),
        userLine(ID_A, { content: [text('context first'), text('<command-name>foo</command-name>')] }),
        userLine(ID_A, { content: [text('keep me'), { type: 'tool_result', tool_use_id: 'x', content: 'result' }] }),
        userLine(ID_A, { content: [{ type: 'tool_result', tool_use_id: 'y', content: 'only a result' }] }),
        userLine(ID_A, { content: [text('<system-reminder>...</system-reminder>')] }),
        userLine(ID_A, { meta: true, content: 'a meta message' }),
        userLine(ID_A, { sidechain: true, content: 'a sidechain prompt' }),
      ].join('\n'),
      lines,
    );
    assert.equal(lines.userMessages, 3);
    assert.equal(lines.typedChars, 'hello world'.length + 'context first'.length + 'keep me'.length);
  });

  test('a reply with text counts once (by message id); thinking and tool calls count per block', () => {
    const lines = newStatsLines();
    parseStatsLines(
      [
        assistantLine(ID_A, { id: 'reply-1', blocks: [thinking()] }),
        assistantLine(ID_A, { id: 'reply-1', blocks: [text('the answer')] }),
        assistantLine(ID_A, { id: 'reply-1', blocks: [toolUse('Edit')] }),
        assistantLine(ID_A, { id: 'reply-2', blocks: [text('second')] }),
      ].join('\n'),
      lines,
    );
    assert.equal(lines.replies, 2);
    assert.equal(lines.replyChars, 'the answer'.length + 'second'.length);
    assert.equal(lines.thinking, 1);
    assert.equal(lines.toolCalls, 1);
    assert.deepEqual([...lines.tools.entries()], [['Edit', 1]]);
  });

  test('a subagent counts its thinking, tools and tokens, not its messages or replies', () => {
    const lines = newStatsLines();
    parseStatsLines(
      [
        userLine(ID_A, { content: 'the subagent prompt' }),
        assistantLine(ID_A, { id: 'sub-1', blocks: [thinking()], input: 100 }),
        assistantLine(ID_A, { id: 'sub-1', blocks: [toolUse('Task')] }),
        assistantLine(ID_A, { id: 'sub-1', blocks: [text('subagent answer')] }),
      ].join('\n'),
      lines,
      true,
    );
    assert.equal(lines.userMessages, 0);
    assert.equal(lines.replies, 0);
    assert.equal(lines.thinking, 1);
    assert.equal(lines.toolCalls, 1);
    assert.equal(lines.subagents, 1);
    assert.equal(lines.calls.size, 1);
    assert.equal(lines.calls.get('sub-1')?.input, 100);
  });

  test('counts what edits added and removed, and a Write create as the file is new', () => {
    const lines = newStatsLines();
    parseStatsLines(
      [
        userLine(ID_A, {
          content: 'ignored',
          toolUseResult: editResult('C:\\work\\shop\\a.ts', ['  unchanged', '-  old', '+  new', '+  newer']),
        }),
        userLine(ID_A, { content: 'ignored', toolUseResult: createResult('C:\\work\\shop\\b.ts', 'one\ntwo\nthree\n') }),
        userLine(ID_A, { content: 'ignored', toolUseResult: { type: 'text', content: 'file contents' } }),
      ].join('\n'),
      lines,
    );
    assert.equal(lines.linesAdded, 2 + 3);
    assert.equal(lines.linesRemoved, 1);
    assert.equal(lines.filesEdited.size, 2);
  });

  test('keeps the last custom title over the generated one, and the first cwd', () => {
    const lines = newStatsLines();
    parseStatsLines(
      [
        line({ type: 'custom-title', customTitle: 'first' }),
        line({ type: 'ai-title', aiTitle: 'generated' }),
        userLine(ID_A, { content: 'hi' }),
        line({ type: 'custom-title', customTitle: 'last' }),
      ].join('\n'),
      lines,
    );
    assert.equal(lines.customTitle, 'last');
    assert.equal(lines.aiTitle, 'generated');
    assert.equal(lines.cwd, FOLDER);
  });

  test('counts each API call once, by model, leaving out made-up replies', () => {
    const lines = newStatsLines();
    parseStatsLines(
      [
        assistantLine(ID_A, { id: 'm1', model: 'deepseek-flash', blocks: [toolUse('Edit')], input: 10, output: 1 }),
        assistantLine(ID_A, { id: 'm1', model: 'deepseek-flash', blocks: [thinking()] }),
        assistantLine(ID_A, { id: 'm2', model: 'claude-opus-5-5', blocks: [text('hi')], input: 5 }),
        assistantLine(ID_A, { id: 'm3', model: '<synthetic>', blocks: [text('interrupted')], input: 99 }),
      ].join('\n'),
      lines,
    );
    assert.equal(lines.calls.size, 2);
    assert.deepEqual(
      [...lines.calls.entries()].map(([id, call]) => [id, call.model, call.input]),
      [
        ['m1', 'deepseek-flash', 10],
        ['m2', 'claude-opus-5-5', 5],
      ],
    );
  });

  test('lines as the CLI writes them (its own key first) count the same', () => {
    const lines = newStatsLines();
    const typed = line({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: 'typed "toolUseResult": here' },
      timestamp: TIMESTAMP,
      cwd: FOLDER,
    });
    const read = line({
      parentUuid: 'p',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
      toolUseResult: { type: 'text', file: {} },
    });
    const edited = line({
      parentUuid: 'p',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: [] },
      toolUseResult: editResult('C:\\work\\a.ts', ['+a']),
    });
    parseStatsLines([typed, read, edited].join('\n'), lines);
    assert.equal(lines.userMessages, 1);
    assert.equal(lines.linesAdded, 1);
  });

  test('redacted thinking counts as thinking', () => {
    const lines = newStatsLines();
    parseStatsLines([assistantLine(ID_A, { id: 'r1', blocks: [redactedThinking()] })].join('\n'), lines);
    assert.equal(lines.thinking, 1);
  });

  test('a broken line is just one line less', () => {
    const lines = newStatsLines();
    parseStatsLines([userLine(ID_A, { content: 'real' }), '{broken json', 'not json at all', '', '   '].join('\n'), lines);
    assert.equal(lines.userMessages, 1);
    assert.equal(lines.typedChars, 'real'.length);
  });
});

describe('readStatsFile', () => {
  test('reads the whole file, then only what was appended, returning an unchanged file as-is', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-stats-'));
    try {
      const file = path.join(dir, 'a.jsonl');
      writeFileSync(file, userLine(ID_A, { content: 'one' }) + '\n');
      const first = await readStatsFile(file, false, undefined);
      assert.ok(first);
      assert.equal(first.lines.userMessages, 1);
      assert.equal(first.offset, first.size);

      assert.equal(await readStatsFile(file, false, first), first);

      appendFileSync(file, userLine(ID_A, { content: 'two' }) + '\n');
      const later = new Date(Date.now() + 60_000);
      utimesSync(file, later, later);
      const second = await readStatsFile(file, false, first);
      assert.ok(second);
      assert.notEqual(second, first);
      assert.equal(second.lines.userMessages, 2);
      assert.equal(second.offset, second.size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a rewritten, shorter file is read again from the start', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-stats-'));
    try {
      const file = path.join(dir, 'a.jsonl');
      writeFileSync(file, userLine(ID_A, { content: 'one' }) + '\n' + userLine(ID_A, { content: 'two' }) + '\n');
      const first = await readStatsFile(file, false, undefined);
      assert.ok(first);
      assert.equal(first.lines.userMessages, 2);

      writeFileSync(file, userLine(ID_A, { content: 'three' }) + '\n');
      utimesSync(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
      const second = await readStatsFile(file, false, first);
      assert.ok(second);
      assert.equal(second.lines.userMessages, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('streaks', () => {
  test('the current streak ends today, or yesterday when today has nothing yet', () => {
    const now = new Date(2026, 9, 24, 12, 0).getTime(); // local noon, 2026-10-24
    assert.deepEqual(streaks(['2026-10-22', '2026-10-23'], now), { activeDays: 2, longestStreak: 2, currentStreak: 2 });
    assert.deepEqual(streaks(['2026-10-23', '2026-10-24'], now), { activeDays: 2, longestStreak: 2, currentStreak: 2 });
    assert.deepEqual(streaks(['2026-10-22', '2026-10-24'], now), { activeDays: 2, longestStreak: 1, currentStreak: 1 });
    assert.deepEqual(streaks(['2026-10-20'], now), { activeDays: 1, longestStreak: 1, currentStreak: 0 });
    assert.deepEqual(streaks([], now), { activeDays: 0, longestStreak: 0, currentStreak: 0 });
  });
});

describe('StatsIndex', () => {
  const A_MAIN = [userLine(ID_A, { content: 'hi from A' }), assistantLine(ID_A, { id: 'a-1', blocks: [text('answer A')], input: 100 })];
  const B_MAIN = [userLine(ID_B, { content: 'hi from B' })];
  const C_MAIN = [userLine(ID_C, { content: 'hi from C', cwd: OTHER_FOLDER })];

  function makeProject(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-stats-'));
    writeSession(root, 'shop', ID_A, A_MAIN);
    writeSession(root, 'shop', ID_B, B_MAIN);
    writeSession(root, 'other', ID_C, C_MAIN);
    return root;
  }

  test('sums sessions and folders, and filters by folder regardless of case or separators', async () => {
    const root = makeProject();
    try {
      const index = new StatsIndex(root);
      const all = await index.answer({ kind: 'transcripts' });
      assert.equal(all.sessions, 3);
      assert.equal(all.folders, 2);
      assert.equal(all.userMessages, 3);
      assert.equal(all.replies, 1);
      assert.equal(all.tokens.input, 100);

      const shop = await index.answer({ kind: 'transcripts', folder: 'c:/work/SHOP' });
      assert.equal(shop.sessions, 2);
      assert.equal(shop.folders, 1);
      assert.equal(shop.userMessages, 2);
      assert.equal(shop.replies, 1);
      assert.equal(shop.tokens.input, 100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cliCosts sums each process run (the last of a startTime) and skips sessions without one', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-stats-'));
    try {
      const cost = (sessionId: string, startTime: number, totalCostUSD: number): string =>
        line({ type: 'cost-state', sessionId, startTime, totalCostUSD, modelUsage: {} });
      writeSession(root, 'shop', ID_A, [
        userLine(ID_A, { content: 'hi' }),
        cost(ID_A, 1000, 1.0),
        cost(ID_A, 1000, 2.5),
        cost(ID_A, 2000, 0.5),
      ]);
      writeSession(root, 'shop', ID_B, [userLine(ID_B, { content: 'hi' }), cost(ID_B, 1000, 3.0)]);
      writeSession(root, 'shop', ID_C, [userLine(ID_C, { content: 'hi' })]); // no cost-state

      const index = new StatsIndex(root);
      assert.deepEqual(await index.answer({ kind: 'cliCosts' }), { [ID_A]: 3.0, [ID_B]: 3.0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sorts tools and models by count, sums tokens, and finds the longest and busiest day', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-stats-'));
    try {
      const day1 = new Date(2026, 9, 20, 10, 0).toISOString();
      const day2 = new Date(2026, 9, 21, 10, 0).toISOString();
      writeSession(root, 'shop', ID_A, [
        userLine(ID_A, { at: day1, content: 'hi' }),
        assistantLine(ID_A, { id: 'm1', model: 'deepseek-flash', blocks: [toolUse('Edit')], input: 10, output: 1 }),
        assistantLine(ID_A, { id: 'm1', model: 'deepseek-flash', blocks: [toolUse('Edit')] }),
        assistantLine(ID_A, { id: 'm2', model: 'claude-opus-5-5', blocks: [toolUse('Read')], input: 5 }),
      ]);
      writeSession(root, 'shop', ID_B, [
        line({ type: 'custom-title', customTitle: 'My session' }),
        userLine(ID_B, { at: day1, content: 'a' }),
        userLine(ID_B, { at: day1, content: 'b' }),
        userLine(ID_B, { at: day2, content: 'c' }),
      ]);

      const index = new StatsIndex(root);
      const stats = await index.answer({ kind: 'transcripts' });
      assert.deepEqual(stats.tools, [
        { name: 'Edit', count: 2 },
        { name: 'Read', count: 1 },
      ]);
      assert.deepEqual(stats.models, [
        { name: 'claude-opus-5-5', count: 1 },
        { name: 'deepseek-flash', count: 1 },
      ]);
      assert.deepEqual(stats.tokens, { input: 15, output: 1, cacheRead: 0, cacheWrite: 0 });
      assert.equal(stats.longest?.sessionId, ID_B);
      assert.equal(stats.longest?.title, 'My session');
      assert.equal(stats.longest?.userMessages, 3);
      assert.equal(stats.busiestDay?.date, '2026-10-20');
      assert.equal(stats.busiestDay?.userMessages, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('puts messages in the weekday/hour grid, and the latest is later in the night (a day from 05:00)', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-stats-'));
    try {
      const beforeMidnight = new Date(2026, 9, 24, 23, 10);
      const inTheNight = new Date(2026, 9, 25, 3, 47);
      writeSession(root, 'shop', ID_A, [
        userLine(ID_A, { at: beforeMidnight.toISOString(), content: 'before midnight' }),
        userLine(ID_A, { at: inTheNight.toISOString(), content: 'in the night' }),
      ]);

      const index = new StatsIndex(root);
      const stats = await index.answer({ kind: 'transcripts' });
      assert.equal(stats.userMessages, 2);
      assert.equal(stats.latest, inTheNight.getTime()); // 03:47 is later than 23:10
      assert.equal(stats.first, beforeMidnight.getTime());
      assert.equal(stats.last, inTheNight.getTime());
      assert.equal(stats.activity[(beforeMidnight.getDay() + 6) % 7][beforeMidnight.getHours()], 1);
      assert.equal(stats.activity[(inTheNight.getDay() + 6) % 7][inTheNight.getHours()], 1);
      assert.equal(stats.activeDays, 2);
      assert.equal(stats.longestStreak, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
