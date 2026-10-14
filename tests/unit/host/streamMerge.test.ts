import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { STREAM_MERGE } from '../../../src/host/exthost/bridge';
import { classify, StreamMerger, valueAt } from '../../../src/host/webview/streamMerge';

// Messages as anthropic.claude-code 2.1.296 sends them to a conversation page.
const io = (message: object, channelId = 'c1', done = false): object => ({
  type: 'from-extension',
  message: { type: 'io_message', channelId, message, done, hostForwardedAt: 1 },
});
const delta = (index: number, value: object, parent: string | null = null, channelId = 'c1'): object =>
  io(
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index, delta: value },
      session_id: 's',
      parent_tool_use_id: parent,
      uuid: 'u',
    },
    channelId,
  );
const text = (t: string, index = 1): object => delta(index, { type: 'text_delta', text: t });
const json = (t: string, index = 1): object => delta(index, { type: 'input_json_delta', partial_json: t });
const thinking = (t: string): object => delta(0, { type: 'thinking_delta', thinking: t });
const tokens = (estimated: number, added: number): object =>
  io({
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: estimated,
    estimated_tokens_delta: added,
    session_id: 's',
    uuid: 'u',
  });
const blockStop = (index: number): object =>
  io({ type: 'stream_event', event: { type: 'content_block_stop', index }, session_id: 's', parent_tool_use_id: null });

const deltaText = (data: unknown): unknown => {
  const d = valueAt(data, ['message', 'message', 'event', 'delta']) as Record<string, unknown>;
  return d.text ?? d.partial_json ?? d.thinking;
};

/** A merger with timers fired by hand; what goes on to the page lands in `out`, in order. */
function harness() {
  const out: unknown[] = [];
  const timers: { callback: () => void; ms: number; live: boolean }[] = [];
  let runs = 0;
  const merger = new StreamMerger<string>(STREAM_MERGE, {
    deliver: (_event, data) => out.push(data),
    delivered: () => runs++,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { live: boolean }).live = false;
    },
  });
  return {
    merger,
    out,
    timers,
    runs: () => runs,
    /** As the page script's listener: what the merger does not hold goes on at once. */
    send(data: object): void {
      if (!merger.take('event', data)) out.push(data);
    },
    fire(): void {
      for (const timer of timers.splice(0)) if (timer.live) timer.callback();
    },
  };
}

describe('stream merge rules (anthropic.claude-code 2.1.296)', () => {
  test('take the three kinds of delta and the thinking token counts', () => {
    for (const message of [text('a'), json('{"'), thinking('Th'), tokens(2, 2)]) {
      assert.ok(classify(message, STREAM_MERGE.rules), JSON.stringify(message));
    }
  });

  test('leave everything else alone', () => {
    const others = [
      blockStop(1),
      delta(0, { type: 'signature_delta', signature: 'x' }),
      io({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } }),
      io({ type: 'assistant', message: { content: [] } }),
      io({ type: 'system', subtype: 'status', status: 'requesting' }),
      io({ type: 'result' }),
      { type: 'from-extension', message: { type: 'response', requestId: 'r', response: {} } },
      { ccwControl: 'theme' },
      // The last message of a channel, and deltas whose text is not text.
      io({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'a' } } }, 'c1', true),
      delta(1, { type: 'text_delta', text: 7 }),
      'plain string',
      null,
    ];
    for (const message of others) {
      assert.equal(classify(message, STREAM_MERGE.rules), undefined, JSON.stringify(message));
    }
  });
});

describe('StreamMerger', () => {
  test('a run of deltas goes to the page as one, after the interval', () => {
    const h = harness();
    for (const piece of ['Hel', 'lo', ', ', 'world']) h.send(text(piece));
    assert.equal(h.out.length, 0);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0]!.ms, STREAM_MERGE.intervalMs);
    h.fire();
    assert.equal(h.out.length, 1);
    assert.equal(deltaText(h.out[0]), 'Hello, world');
    assert.equal(h.runs(), 1);
  });

  test('anything else lets out what is held first, so the page sees the same order', () => {
    const h = harness();
    h.send(json('{"file_path":'));
    h.send(json('"a.gd"}'));
    const stop = blockStop(1);
    h.send(stop);
    assert.equal(h.out.length, 2);
    assert.equal(deltaText(h.out[0]), '{"file_path":"a.gd"}');
    assert.equal(h.out[1], stop);
    // The timer of the run is gone with it.
    h.fire();
    assert.equal(h.out.length, 2);
  });

  test('thinking and its token counts, which alternate, merge each with its own', () => {
    const h = harness();
    h.send(thinking('The'));
    h.send(tokens(1, 1));
    h.send(thinking(' user'));
    h.send(tokens(3, 2));
    h.send(thinking(' wants'));
    h.send(tokens(5, 2));
    h.fire();
    assert.equal(h.out.length, 2);
    assert.equal(deltaText(h.out[0]), 'The user wants');
    assert.equal(valueAt(h.out[1], ['message', 'message', 'estimated_tokens']), 5);
    assert.equal(valueAt(h.out[1], ['message', 'message', 'estimated_tokens_delta']), 5);
  });

  test('other blocks, channels and subagents do not merge', () => {
    const h = harness();
    h.send(text('a', 1));
    h.send(text('b', 2));
    h.send(delta(1, { type: 'text_delta', text: 'c' }, 'toolu_1'));
    h.send(delta(1, { type: 'text_delta', text: 'd' }, null, 'c2'));
    h.send(json('e', 1));
    h.fire();
    assert.deepEqual(h.out.map(deltaText), ['a', 'b', 'c', 'd', 'e']);
  });

  test('a page slow to render waits longer, up to a second', () => {
    const h = harness();
    h.merger.rendered(300);
    h.send(text('a'));
    assert.equal(h.timers[0]!.ms, 300);
    h.fire();
    h.merger.rendered(5000);
    h.send(text('b'));
    assert.equal(h.timers[0]!.ms, 1000);
    h.fire();
    h.merger.rendered(1);
    h.send(text('c'));
    assert.equal(h.timers[0]!.ms, STREAM_MERGE.intervalMs);
  });

  test('a flush with nothing held hands nothing', () => {
    const h = harness();
    h.merger.flush();
    h.send(blockStop(0));
    assert.equal(h.runs(), 0);
    assert.equal(h.out.length, 1);
  });
});
