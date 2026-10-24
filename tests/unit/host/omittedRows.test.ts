import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { omissionEnd, rowOf } from '../../../src/host/webview/omittedRows';

const HINTS = { blockTypes: ['tool_use', 'thinking'], unseenTools: ['Read', 'ToolSearch'] };
const claude = (uuid: string, block: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid,
  message: { content: [block] },
  ...extra,
});

describe('rowOf', () => {
  test("Claude's thinking and tool calls may be left out; text, the user's messages and unseen tools may not", () => {
    assert.deepEqual(rowOf(claude('a', { type: 'thinking', thinking: 'x' }), HINTS), { uuid: 'a', omissible: true, user: false });
    assert.deepEqual(rowOf(claude('b', { type: 'tool_use', name: 'Bash' }), HINTS), { uuid: 'b', omissible: true, user: false });
    assert.deepEqual(rowOf(claude('c', { type: 'text', text: 'x' }), HINTS), { uuid: 'c', omissible: false, user: false });
    assert.deepEqual(rowOf(claude('d', { type: 'tool_use', name: 'Read' }), HINTS), { uuid: 'd', omissible: false, user: false });
    assert.deepEqual(rowOf({ type: 'user', uuid: 'e', message: { content: 'hi' } }, HINTS), { uuid: 'e', omissible: false, user: true });
  });

  test("tool results, a subagent's messages and others are no rows", () => {
    const result = { type: 'user', uuid: 'r', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } };
    assert.equal(rowOf(result, HINTS), undefined);
    assert.equal(rowOf(claude('s', { type: 'thinking' }, { parent_tool_use_id: 'toolu_1' }), HINTS), undefined);
    assert.equal(rowOf({ type: 'system', uuid: 'y' }, HINTS), undefined);
    assert.equal(rowOf({ type: 'assistant' }, HINTS), undefined);
  });
});

describe('omissionEnd', () => {
  // Three rows a turn: the user's question, a call, its answer. The page shows Claude's (by uuid) only.
  const messages = Array.from({ length: 30 }, (_, i) => ({ uuid: `m${i}`, omissible: i % 3 === 1, user: i % 3 === 0 }));
  const claudes = new Set(messages.filter((message) => !message.user).map((message) => message.uuid));
  const without = (...uuids: string[]) => new Set([...claudes].filter((uuid) => !uuids.includes(uuid)));

  test('none under the limit, whatever the page shows', () => {
    assert.equal(omissionEnd(messages, new Set(), 30), undefined);
  });

  test('right after the latest call left out: its answer, in its turn', () => {
    assert.equal(omissionEnd(messages, claudes, 10), undefined);
    assert.deepEqual(omissionEnd(messages, without('m1', 'm4', 'm7'), 10), { uuid: 'm8', beforeTurn: false });
    // Fewer than three left out is not the page's limit.
    assert.equal(omissionEnd(messages, without('m1', 'm4'), 10), undefined);
    // Answers it does not show are not its leaving out.
    assert.equal(omissionEnd(messages, without('m2', 'm5', 'm8'), 10), undefined);
  });

  test("before the next turn when the user's message comes first", () => {
    // The latest call left out (m7) and its answer (m8) both gone: the next shown is m10, after the question m9.
    assert.deepEqual(omissionEnd(messages, without('m1', 'm4', 'm7', 'm8'), 10), { uuid: 'm10', beforeTurn: true });
  });

  test('not the end a rewind took away, nor another conversation', () => {
    assert.equal(omissionEnd(messages, without('m22', 'm25', 'm28'), 10), undefined);
    assert.equal(omissionEnd(messages, new Set(['other']), 10), undefined);
  });
});
