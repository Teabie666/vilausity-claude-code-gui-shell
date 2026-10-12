import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeWebviewBridge, conversationSessionId, describeShape, usageResetsOf } from '../../../src/host/exthost/bridge';
import { CommentStore } from '../../../src/host/exthost/comments';
import { NullLogger } from '../../../src/platform/log';
import type { WebviewImpl } from '../../../src/compat/vscode/webviews';
import type { OsBackend } from '../../../src/compat/vscode/host';

function makeWebview(): { webview: WebviewImpl; messages: unknown[] } {
  const messages: unknown[] = [];
  const webview = {
    postMessage(message: unknown) {
      messages.push(message);
      return Promise.resolve(true);
    },
  } as unknown as WebviewImpl;
  return { webview, messages };
}

function makeOs(): { os: OsBackend; opened: string[] } {
  const opened: string[] = [];
  const os: OsBackend = {
    openExternal: async (url: string) => {
      opened.push(url);
      return true;
    },
    clipboardRead: async () => '',
    clipboardWrite: async () => {},
  };
  return { os, opened };
}

function makeBridge(diffEditorAvailable: boolean) {
  const { webview, messages } = makeWebview();
  const { os, opened } = makeOs();
  const bridge = new ClaudeWebviewBridge(os, NullLogger, {
    diffEditorAvailable: () => diffEditorAvailable,
    comments: new CommentStore(),
    workspaceFolders: [],
  });
  return { bridge, webview, messages, opened };
}

describe('ClaudeWebviewBridge', () => {
  test('holds open_diff without answering when diff editing is unavailable and answers it on the matching cancel', () => {
    const { bridge, webview, messages } = makeBridge(false);
    const request = { type: 'request', requestId: 'r1', channelId: 'c1', request: { type: 'open_diff' } };
    assert.equal(bridge.interceptFromWebview(webview, request), true);
    assert.deepEqual(messages, []);

    assert.equal(bridge.interceptFromWebview(webview, { type: 'cancel_request', targetRequestId: 'other' }), false);
    assert.deepEqual(messages, []);

    assert.equal(bridge.interceptFromWebview(webview, { type: 'cancel_request', targetRequestId: 'r1' }), true);
    assert.deepEqual(messages, [
      { type: 'from-extension', message: { type: 'response', requestId: 'r1', response: { type: 'open_diff_response' } } },
    ]);
  });

  test('answers accept_diff immediately with found: false when diff editing is unavailable', () => {
    const { bridge, webview, messages } = makeBridge(false);
    assert.equal(bridge.interceptFromWebview(webview, { type: 'request', requestId: 'r1', request: { type: 'accept_diff' } }), true);
    assert.deepEqual(messages, [
      { type: 'from-extension', message: { type: 'response', requestId: 'r1', response: { type: 'accept_diff_response', found: false } } },
    ]);
  });

  test('passes open_diff and accept_diff through when diff editing is available', () => {
    const { bridge, webview, messages } = makeBridge(true);
    assert.equal(bridge.interceptFromWebview(webview, { type: 'request', requestId: 'r1', request: { type: 'open_diff' } }), false);
    assert.equal(bridge.interceptFromWebview(webview, { type: 'request', requestId: 'r2', request: { type: 'accept_diff' } }), false);
    assert.deepEqual(messages, []);
  });

  test('open_url calls openExternal with the raw url string and replies open_url_response', () => {
    const { bridge, webview, messages, opened } = makeBridge(false);
    const url = 'https://example.com/a%20b?x=1&y=2';
    assert.equal(bridge.interceptFromWebview(webview, { type: 'request', requestId: 'r1', request: { type: 'open_url', url } }), true);
    assert.deepEqual(opened, [url]);
    assert.deepEqual(messages, [
      { type: 'from-extension', message: { type: 'response', requestId: 'r1', response: { type: 'open_url_response' } } },
    ]);
  });

  test('passes unknown request types and non-request messages through', () => {
    const { bridge, webview, messages } = makeBridge(false);
    assert.equal(bridge.interceptFromWebview(webview, { type: 'request', requestId: 'r1', request: { type: 'some_other' } }), false);
    assert.equal(bridge.interceptFromWebview(webview, { type: 'unknown' }), false);
    assert.equal(bridge.interceptFromWebview(webview, 'not an object'), false);
    assert.equal(bridge.interceptFromWebview(webview, null), false);
    assert.equal(bridge.interceptFromWebview(webview, 42), false);
    assert.deepEqual(messages, []);
  });

  test('passes io_message through', () => {
    const { bridge, webview, messages } = makeBridge(false);
    assert.equal(bridge.interceptFromWebview(webview, { type: 'io_message', channelId: 'c1', message: 'hi', done: false }), false);
    assert.deepEqual(messages, []);
  });
});

describe('ClaudeWebviewBridge and sessions', () => {
  const statesUpdate = (fields: Record<string, unknown>): unknown => ({
    type: 'from-extension',
    message: { type: 'request', channelId: '', requestId: 'r1', request: { type: 'session_states_update', sessions: [], ...fields } },
  });
  const pageOf = (viewType: string): { webview: WebviewImpl; messages: unknown[] } => {
    const { webview, messages } = makeWebview();
    return { webview: Object.assign(webview, { viewType }), messages };
  };

  test('knows the sessions open here and held elsewhere from what the extension tells its pages', () => {
    const { bridge, webview } = makeBridge(true);
    assert.equal(bridge.sessionBusy('a'), undefined);
    bridge.observeToWebview(webview, statesUpdate({ openSessionIds: ['a'], liveElsewhereSessions: [{ sessionId: 'b', pid: 7 }, 'c'] }));
    assert.equal(bridge.sessionBusy('a'), 'open');
    assert.equal(bridge.sessionBusy('b'), 'elsewhere');
    assert.equal(bridge.sessionBusy('c'), 'elsewhere');
    assert.equal(bridge.sessionBusy('d'), undefined);
    // A field left out keeps its value; other messages change nothing.
    bridge.observeToWebview(webview, statesUpdate({ liveElsewhereSessions: [] }));
    bridge.observeToWebview(webview, { type: 'from-extension', message: { type: 'response', requestId: 'x', response: {} } });
    assert.equal(bridge.sessionBusy('a'), 'open');
    assert.equal(bridge.sessionBusy('b'), undefined);
  });

  test('tells the page how many sessions wait for the user', () => {
    const { bridge, webview, messages } = makeBridge(true);
    const sessions = [
      { sessionId: 'a', state: 'waiting', title: 'A' },
      { sessionId: 'b', state: 'running', title: 'B' },
      { sessionId: 'c', state: 'waiting', title: 'C' },
    ];
    bridge.observeToWebview(webview, statesUpdate({ sessions }));
    assert.deepEqual(messages, [{ ccwControl: 'needsInput', count: 2 }]);
  });

  test("asks the extension's session pages to list the sessions again", () => {
    const { bridge } = makeBridge(true);
    const list = pageOf('claudeVSCodeSessionsList');
    const panel = pageOf('claudeVSCodePanel');
    const other = pageOf('claudePlanPreview');
    bridge.sessionStoreChanged([list.webview, panel.webview, other.webview]);
    for (const { messages } of [list, panel]) {
      assert.equal(messages.length, 1);
      const sent = messages[0] as { type: string; message: { type: string; request: { type: string } } };
      assert.equal(sent.type, 'from-extension');
      assert.equal(sent.message.type, 'request');
      assert.equal(sent.message.request.type, 'session_store_changed');
    }
    assert.equal(other.messages.length, 0);
  });

  test('the session list page is told where its rows and their buttons are', () => {
    const { bridge } = makeBridge(true);
    const rows = bridge.pageHints(pageOf('claudeVSCodeSessionsList').webview)?.sessionRows;
    assert.equal(rows?.idPrefix, 'sessions-list-row-');
    assert.equal(bridge.pageHints(pageOf('claudeVSCodePanel').webview)?.sessionRows, undefined);
  });
});

describe('usage reset times', () => {
  const fromExtension = (message: unknown): unknown => ({ type: 'from-extension', message });

  test('come from panel_usage_update, in seconds, by the bar each window shows as', () => {
    const update = fromExtension({
      type: 'request',
      channelId: '',
      requestId: 'r',
      request: {
        type: 'panel_usage_update',
        unifiedWindows: {
          five_hour: { utilization: 0.4, resetsAt: 1_791_800_000 },
          seven_day: { utilization: 0.1, resetsAt: 1_792_300_000 },
          seven_day_overage_included: null,
          some_new_window: { utilization: 0.2, resetsAt: 1 },
        },
      },
    });
    assert.deepEqual(usageResetsOf(update), { 'Session (5hr)': 1_791_800_000_000, 'Weekly (7 day)': 1_792_300_000_000 });
  });

  test("come from get_usage_response's rate limits, as ISO dates, with the per-model ones", () => {
    const response = fromExtension({
      type: 'response',
      requestId: 'r',
      response: {
        type: 'get_usage_response',
        usage: {
          rate_limits: {
            five_hour: { utilization: 40, resets_at: '2026-10-12T15:42:00Z' },
            seven_day: { utilization: 10, resets_at: null },
            seven_day_sonnet: { utilization: 5, resets_at: '2026-10-15T09:00:00Z' },
            model_scoped: [{ display_name: 'Opus', utilization: 30, resets_at: '2026-10-16T09:00:00Z' }],
          },
        },
      },
    });
    assert.deepEqual(usageResetsOf(response), {
      'Session (5hr)': Date.parse('2026-10-12T15:42:00Z'),
      'Weekly Sonnet': Date.parse('2026-10-15T09:00:00Z'),
      'Weekly Opus': Date.parse('2026-10-16T09:00:00Z'),
    });
  });

  test('other messages carry none', () => {
    assert.equal(usageResetsOf(fromExtension({ type: 'request', request: { type: 'session_store_changed' } })), undefined);
    assert.equal(usageResetsOf(fromExtension({ type: 'response', response: { type: 'get_usage_response', error: 'x' } })), undefined);
    assert.equal(usageResetsOf({ type: 'io_message' }), undefined);
  });

  test("the bridge hands them to the page's script", () => {
    const { bridge, webview, messages } = makeBridge(true);
    const update = fromExtension({
      type: 'request',
      request: { type: 'panel_usage_update', unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1_791_800_000 } } },
    });
    bridge.observeToWebview(webview, update);
    assert.deepEqual(messages, [{ ccwControl: 'usageResets', resets: { 'Session (5hr)': 1_791_800_000_000 } }]);
  });
});

describe('conversationSessionId', () => {
  test('reads the session id a conversation page saves in its state', () => {
    assert.equal(conversationSessionId({ sessionID: 'abc', sessionUpdatedAt: 1 }), 'abc');
  });

  test('does not count a new session that has no transcript yet', () => {
    assert.equal(conversationSessionId({ sessionID: 'abc', sessionWithNoTranscript: 'abc' }), undefined);
    assert.equal(conversationSessionId({ sessionID: 'abc', sessionWithNoTranscript: undefined }), 'abc');
  });

  test('is undefined before the page names a session, and for states of another shape', () => {
    for (const state of [undefined, null, 'abc', {}, { sessionID: '' }, { sessionID: 42 }, { sessionId: 'abc' }]) {
      assert.equal(conversationSessionId(state), undefined);
    }
  });
});

describe('describeShape', () => {
  test('summarizes structure without string content and keeps type/role literal values', () => {
    assert.equal(
      describeShape({ type: 'user', message: 'hello world', nested: { role: 'assistant' } }),
      '{type: "user", message: string, nested: {role: "assistant"}}',
    );
    assert.equal(describeShape([{ type: 'user' }]), '[{type: "user"}]');
    assert.equal(describeShape([]), '[]');
    assert.equal(describeShape([['secret']]), '[[string]]');
  });

  test('reports primitive types without their values', () => {
    assert.equal(describeShape('a secret'), 'string');
    assert.equal(describeShape(42), 'number');
    assert.equal(describeShape(true), 'boolean');
    assert.equal(describeShape(undefined), 'undefined');
  });

  test('collapses objects beyond the depth limit to object', () => {
    assert.equal(describeShape({ a: { b: { c: { d: { e: { f: 'x' } } } } } }), '{a: {b: {c: {d: {e: object}}}}}');
  });
});
