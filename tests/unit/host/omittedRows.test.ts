import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { omittedCount, rowOf } from '../../../src/host/webview/omittedRows';

const HINTS = { blockTypes: ['tool_use', 'thinking'], unseenTools: ['Read', 'ToolSearch'] };
const claude = (uuid: string, block: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid,
  message: { content: [block] },
  ...extra,
});

describe('rowOf', () => {
  test("Claude's thinking and tool calls may be left out; text, the user's messages and unseen tools may not", () => {
    assert.deepEqual(rowOf(claude('a', { type: 'thinking', thinking: 'x' }), HINTS), { uuid: 'a', omissible: true });
    assert.deepEqual(rowOf(claude('b', { type: 'tool_use', name: 'Bash' }), HINTS), { uuid: 'b', omissible: true });
    assert.deepEqual(rowOf(claude('c', { type: 'text', text: 'x' }), HINTS), { uuid: 'c', omissible: false });
    assert.deepEqual(rowOf(claude('d', { type: 'tool_use', name: 'Read' }), HINTS), { uuid: 'd', omissible: false });
    assert.deepEqual(rowOf({ type: 'user', uuid: 'e', message: { content: 'hi' } }, HINTS), { uuid: 'e', omissible: false });
  });

  test("tool results, a subagent's messages and others are no rows", () => {
    const result = { type: 'user', uuid: 'r', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } };
    assert.equal(rowOf(result, HINTS), undefined);
    assert.equal(rowOf(claude('s', { type: 'thinking' }, { parent_tool_use_id: 'toolu_1' }), HINTS), undefined);
    assert.equal(rowOf({ type: 'system', uuid: 'y' }, HINTS), undefined);
    assert.equal(rowOf({ type: 'assistant' }, HINTS), undefined);
  });
});

describe('omittedCount', () => {
  // Three rows a turn: a call, its answer, the next question.
  const messages = Array.from({ length: 30 }, (_, i) => ({ uuid: `m${i}`, omissible: i % 3 === 0 }));
  const all = new Set(messages.map((message) => message.uuid));
  const without = (...uuids: string[]) => new Set([...all].filter((uuid) => !uuids.includes(uuid)));

  test('none under the limit, whatever the page shows', () => {
    assert.equal(omittedCount(messages, new Set(), 30), 0);
  });

  test('the calls before the last one the page shows, that it does not show', () => {
    assert.equal(omittedCount(messages, all, 10), 0);
    assert.equal(omittedCount(messages, without('m0', 'm3', 'm6'), 10), 3);
    // Answers it does not show are not its leaving out.
    assert.equal(omittedCount(messages, without('m1', 'm2'), 10), 0);
  });

  test('not the end a rewind took away, nor another conversation', () => {
    assert.equal(omittedCount(messages, without('m21', 'm24', 'm27'), 10), 0);
    assert.equal(omittedCount(messages, new Set(['other']), 10), 0);
  });
});
