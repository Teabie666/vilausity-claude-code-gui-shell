import { afterEach, beforeEach, describe, mock, test } from 'node:test';
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
      { sessionId: 'a', state: 'waiting_input', title: 'A' },
      { sessionId: 'b', state: 'running', title: 'B' },
      { sessionId: 'c', state: 'waiting_input', title: 'C' },
      { sessionId: 'd', state: 'idle', title: 'D' },
    ];
    bridge.observeToWebview(webview, statesUpdate({ sessions }));
    assert.deepEqual(messages, [{ ccwControl: 'needsInput', count: 2 }]);
  });

  test('reports what the conversations are doing once per change, though every page is told', () => {
    const activities: unknown[] = [];
    const bridge = new ClaudeWebviewBridge(makeOs().os, NullLogger, {
      diffEditorAvailable: () => true,
      comments: new CommentStore(),
      workspaceFolders: [],
      onActivity: (activity) => activities.push(activity),
    });
    const list = pageOf('claudeVSCodeSessionsList');
    const panel = pageOf('claudeVSCodePanel');
    const tell = (sessions: unknown[]): void => {
      for (const page of [list, panel]) {
        bridge.observeToWebview(page.webview, statesUpdate({ sessions }));
      }
    };
    tell([{ sessionId: 'a', state: 'idle', title: 'A' }]);
    assert.deepEqual(activities, []);
    tell([{ sessionId: 'a', state: 'running', title: 'A' }]);
    tell([
      { sessionId: 'a', state: 'running', title: 'A' },
      { sessionId: 'b', state: 'waiting_input', title: 'B' },
    ]);
    // A title change alone is no change of activity.
    tell([
      { sessionId: 'a', state: 'running', title: 'A2' },
      { sessionId: 'b', state: 'waiting_input', title: 'B' },
    ]);
    tell([]);
    assert.deepEqual(activities, [
      { running: 1, waiting: 0 },
      { running: 1, waiting: 1 },
      { running: 0, waiting: 0 },
    ]);
    // An update without `sessions` (only what is open) changes nothing.
    bridge.observeToWebview(list.webview, {
      type: 'from-extension',
      message: { type: 'request', channelId: '', requestId: 'r2', request: { type: 'session_states_update', openSessionIds: [] } },
    });
    assert.equal(activities.length, 3);
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

function fakeWebview(id: string, viewType: string): WebviewImpl {
  return { id, viewType, postMessage: () => Promise.resolve(true) } as unknown as WebviewImpl;
}

function openInEditor(requestId: string, sessionId: string): unknown {
  return { type: 'request', channelId: 'c', requestId, request: { type: 'open_in_editor', sessionId } };
}

function userMessage(): unknown {
  return {
    type: 'io_message',
    channelId: 'c',
    message: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    done: false,
  };
}

function makePreviewBridge(pinned?: string[]): ClaudeWebviewBridge {
  const { os } = makeOs();
  return new ClaudeWebviewBridge(os, NullLogger, {
    diffEditorAvailable: () => true,
    comments: new CommentStore(),
    workspaceFolders: [],
    ...(pinned ? { pinPreview: (id: string) => void pinned.push(id) } : {}),
  });
}

describe('ClaudeWebviewBridge and previews', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: 1000 });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  test('marks one panel a preview while an open is pending, and only one per click', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    assert.equal(bridge.interceptFromWebview(list, openInEditor('r1', 'S1')), false);
    assert.equal(bridge.opensAsPreview(fakeWebview('panel-1', 'claudeVSCodePanel')), true);
    assert.equal(bridge.opensAsPreview(fakeWebview('panel-2', 'claudeVSCodePanel')), false);
    assert.deepEqual(pinned, []);
  });

  test('the extension answering the open ends the preview window', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    bridge.observeToWebview(list, {
      type: 'from-extension',
      message: { type: 'response', requestId: 'r1', response: { type: 'open_in_editor_response' } },
    });
    assert.equal(bridge.opensAsPreview(fakeWebview('panel', 'claudeVSCodePanel')), false);
    assert.deepEqual(pinned, []);
  });

  test('a response for a different request does not end the preview', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    bridge.observeToWebview(list, {
      type: 'from-extension',
      message: { type: 'response', requestId: 'other', response: { type: 'open_in_editor_response' } },
    });
    assert.equal(bridge.opensAsPreview(fakeWebview('panel', 'claudeVSCodePanel')), true);
  });

  test('returns false when nothing was clicked', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    assert.equal(bridge.opensAsPreview(fakeWebview('panel', 'claudeVSCodePanel')), false);
  });

  test('a plan preview is not a preview, and does not consume the pending open', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    assert.equal(bridge.opensAsPreview(fakeWebview('plan', 'claudePlanPreview')), false);
    assert.equal(bridge.opensAsPreview(fakeWebview('panel', 'claudeVSCodePanel')), true);
  });

  test('an open_in_editor from a conversation panel does not count', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    bridge.interceptFromWebview(fakeWebview('panel', 'claudeVSCodePanel'), openInEditor('r1', 'S1'));
    assert.equal(bridge.opensAsPreview(fakeWebview('panel-2', 'claudeVSCodePanel')), false);
  });

  test('an open_in_editor without a sessionId does not count', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    bridge.interceptFromWebview(list, { type: 'request', channelId: 'c', requestId: 'r1', request: { type: 'open_in_editor' } });
    assert.equal(bridge.opensAsPreview(fakeWebview('panel', 'claudeVSCodePanel')), false);
  });

  test('times out: a panel after OPEN_TIMEOUT_MS is not a preview', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    mock.timers.tick(5001); // OPEN_TIMEOUT_MS is 5000
    assert.equal(bridge.opensAsPreview(fakeWebview('panel', 'claudeVSCodePanel')), false);
  });

  test('a double click pins the panel the first click already made a preview', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    const panel = fakeWebview('panel', 'claudeVSCodePanel');
    assert.equal(bridge.opensAsPreview(panel), true);
    bridge.interceptFromWebview(list, openInEditor('r2', 'S1'));
    assert.deepEqual(pinned, ['panel']);
  });

  test('two clicks before any panel: the later panel is not a preview and nothing is pinned', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    bridge.interceptFromWebview(list, openInEditor('r2', 'S1'));
    assert.equal(bridge.opensAsPreview(fakeWebview('panel', 'claudeVSCodePanel')), false);
    assert.deepEqual(pinned, []);
  });

  test('a second open after DOUBLE_CLICK_MS is not a double click', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    mock.timers.tick(500); // DOUBLE_CLICK_MS is 500; equal is not "less than"
    bridge.interceptFromWebview(list, openInEditor('r2', 'S1'));
    assert.deepEqual(pinned, []);
    assert.equal(bridge.opensAsPreview(fakeWebview('panel', 'claudeVSCodePanel')), true);
  });

  test('a second open of a different session is not a double click', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    mock.timers.tick(100);
    bridge.interceptFromWebview(list, openInEditor('r2', 'S2'));
    assert.deepEqual(pinned, []);
    assert.equal(bridge.opensAsPreview(fakeWebview('panel', 'claudeVSCodePanel')), true);
  });

  test('a user message in a preview panel pins it once', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    const panel = fakeWebview('panel', 'claudeVSCodePanel');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    assert.equal(bridge.opensAsPreview(panel), true);
    assert.equal(bridge.interceptFromWebview(panel, userMessage()), false);
    assert.deepEqual(pinned, ['panel']);
    assert.equal(bridge.interceptFromWebview(panel, userMessage()), false);
    assert.deepEqual(pinned, ['panel']);
  });

  test('a message in a panel that is not a preview does not pin', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const panel = fakeWebview('panel', 'claudeVSCodePanel');
    assert.equal(bridge.interceptFromWebview(panel, userMessage()), false);
    assert.deepEqual(pinned, []);
  });

  test('an io_message that is not a user message does not pin', () => {
    const pinned: string[] = [];
    const bridge = makePreviewBridge(pinned);
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    const panel = fakeWebview('panel', 'claudeVSCodePanel');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    assert.equal(bridge.opensAsPreview(panel), true);
    bridge.interceptFromWebview(panel, { type: 'io_message', channelId: 'c', message: { type: 'assistant', message: {} }, done: false });
    assert.deepEqual(pinned, []);
  });

  test('works without a pinPreview callback', () => {
    const bridge = makePreviewBridge();
    const list = fakeWebview('list', 'claudeVSCodeSessionsList');
    const panel = fakeWebview('panel', 'claudeVSCodePanel');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    assert.equal(bridge.opensAsPreview(panel), true);
    assert.equal(bridge.interceptFromWebview(panel, userMessage()), false); // pins without a callback

    const bridge2 = makePreviewBridge();
    const list2 = fakeWebview('list2', 'claudeVSCodeSessionsList');
    bridge2.interceptFromWebview(list2, openInEditor('r1', 'S1'));
    assert.equal(bridge2.opensAsPreview(fakeWebview('panel2', 'claudeVSCodePanel')), true);
    bridge2.interceptFromWebview(list2, openInEditor('r2', 'S1')); // double click pins without a callback
  });
});

describe('ClaudeWebviewBridge, previews and the session list', () => {
  const states = (openSessionIds: string[]) => ({
    type: 'from-extension',
    message: {
      type: 'request',
      channelId: '',
      requestId: 'states',
      request: { type: 'session_states_update', sessions: [], activeSessionId: 'S1', openSessionIds },
    },
  });
  const statesOf = (messages: unknown[]) =>
    messages.filter(
      (message) => (message as { message?: { request?: { type?: string } } }).message?.request?.type === 'session_states_update',
    );
  const openIdsOf = (message: unknown) =>
    (message as { message: { request: { openSessionIds?: string[] } } }).message.request.openSessionIds;

  function previewing() {
    // The session states the list page is sent (it also gets the shell's needs-input count).
    const sent: unknown[] = [];
    const posted = {
      get length() {
        return statesOf(sent).length;
      },
      at: (index: number) => statesOf(sent)[index],
    };
    const bridge = makePreviewBridge();
    const list = {
      id: 'list',
      viewType: 'claudeVSCodeSessionsList',
      postMessage: (message: unknown) => (sent.push(message), Promise.resolve(true)),
    } as unknown as WebviewImpl;
    const chat = fakeWebview('chat', 'claudeVSCodePanel');
    bridge.interceptFromWebview(list, openInEditor('r1', 'S1'));
    const panel = fakeWebview('panel', 'claudeVSCodePanel');
    assert.equal(bridge.opensAsPreview(panel), true);
    return { bridge, list, chat, panel, posted };
  }

  test('the list is not told that a session in preview is open; other pages are', () => {
    const { bridge, list, chat } = previewing();
    const replaced = bridge.observeToWebview(list, states(['S0', 'S1']));
    assert.deepEqual(openIdsOf(replaced), ['S0']);
    assert.equal(bridge.observeToWebview(chat, states(['S0', 'S1'])), undefined);
    // Nothing in preview among them: posted as it is.
    assert.equal(bridge.observeToWebview(list, states(['S0'])), undefined);
  });

  test('keeping the preview tells the list again, with its session open', () => {
    const { bridge, list, panel, posted } = previewing();
    bridge.observeToWebview(list, states(['S0', 'S1']));
    bridge.keepPreview(panel.id);
    assert.equal(posted.length, 1);
    assert.deepEqual(openIdsOf(posted.at(0)), ['S0', 'S1']);
    // Its own post is not looked at again, and a second keep tells nothing.
    assert.equal(bridge.observeToWebview(list, posted.at(0)), undefined);
    bridge.keepPreview(panel.id);
    assert.equal(posted.length, 1);
    assert.equal(bridge.observeToWebview(list, states(['S0', 'S1'])), undefined);
  });

  test('a message sent in the preview keeps it and tells the list', () => {
    const { bridge, list, panel, posted } = previewing();
    bridge.observeToWebview(list, states(['S1']));
    bridge.interceptFromWebview(panel, userMessage());
    assert.deepEqual(openIdsOf(posted.at(0)), ['S1']);
  });

  test('a preview that closes is forgotten, and so is a list page that goes', () => {
    const { bridge, list, panel, posted } = previewing();
    bridge.observeToWebview(list, states(['S1']));
    bridge.didDisposeWebview(panel);
    assert.equal(bridge.observeToWebview(list, states(['S1'])), undefined);
    bridge.didDisposeWebview(list);
    bridge.keepPreview(panel.id);
    assert.equal(posted.length, 0);
  });

  test('a conversation page is told how its own Escapes work, which the shell takes over', () => {
    const hints = makePreviewBridge().pageHints(fakeWebview('chat', 'claudeVSCodePanel'));
    assert.equal(hints?.conversationEscapes?.input, '[role="textbox"][aria-label="Message input"]');
    assert.equal(hints?.conversationEscapes?.doubleMs, 800);
    assert.equal(makePreviewBridge().pageHints(fakeWebview('list', 'claudeVSCodeSessionsList'))?.conversationEscapes, undefined);
  });
});

describe('ClaudeWebviewBridge and what Claude Code says', () => {
  function makeOutputBridge() {
    const events: string[] = [];
    const bridge = new ClaudeWebviewBridge(makeOs().os, NullLogger, {
      diffEditorAvailable: () => true,
      comments: new CommentStore(),
      workspaceFolders: [],
      onSessionStarted: (sessionId) => events.push(`started ${sessionId}`),
      onSessionUsed: (sessionId) => events.push(`used ${sessionId}`),
      onTurnEnded: (sessionId) => events.push(`ended ${sessionId ?? '-'}`),
    });
    return { bridge, events };
  }
  const output = (channelId: string, message: Record<string, unknown>): unknown => ({
    type: 'from-extension',
    message: { type: 'io_message', channelId, message, done: false },
  });
  const init = (channelId: string, sessionId: string): unknown =>
    output(channelId, { type: 'system', subtype: 'init', session_id: sessionId });
  const reply = (channelId: string, sessionId?: string): unknown =>
    output(channelId, { type: 'assistant', session_id: sessionId, message: { id: 'm', usage: { input_tokens: 1 } } });
  const result = (channelId: string): unknown => output(channelId, { type: 'result', subtype: 'success' });

  test('reports a process that starts on a session, its first reply once, and the end of each turn', () => {
    const { bridge, events } = makeOutputBridge();
    const panel = fakeWebview('panel', 'claudeVSCodePanel');
    assert.equal(bridge.observeToWebview(panel, init('c1', 'S1')), undefined);
    bridge.observeToWebview(panel, reply('c1', 'S1'));
    bridge.observeToWebview(panel, reply('c1', 'S1'));
    bridge.observeToWebview(panel, result('c1'));
    bridge.observeToWebview(panel, reply('c1', 'S1'));
    bridge.observeToWebview(panel, result('c1'));
    assert.deepEqual(events, ['started S1', 'used S1', 'ended S1', 'ended S1']);
  });

  test('a process that only started (a session opened, nothing sent) is never reported used', () => {
    const { bridge, events } = makeOutputBridge();
    bridge.observeToWebview(fakeWebview('panel', 'claudeVSCodePanel'), init('c1', 'S1'));
    assert.deepEqual(events, ['started S1']);
  });

  test('a new process on the same channel is reported used again', () => {
    const { bridge, events } = makeOutputBridge();
    const panel = fakeWebview('panel', 'claudeVSCodePanel');
    bridge.observeToWebview(panel, init('c1', 'S1'));
    bridge.observeToWebview(panel, reply('c1', 'S1'));
    bridge.observeToWebview(panel, init('c1', 'S1'));
    bridge.observeToWebview(panel, reply('c1', 'S1'));
    assert.deepEqual(events, ['started S1', 'used S1', 'started S1', 'used S1']);
  });

  test('replies that name another session (after /clear) start that session', () => {
    const { bridge, events } = makeOutputBridge();
    const panel = fakeWebview('panel', 'claudeVSCodePanel');
    bridge.observeToWebview(panel, init('c1', 'S1'));
    bridge.observeToWebview(panel, reply('c1', 'S1'));
    bridge.observeToWebview(panel, reply('c1', 'S2'));
    bridge.observeToWebview(panel, reply('c1', 'S2'));
    assert.deepEqual(events, ['started S1', 'used S1', 'started S2', 'used S2']);
  });

  test('keeps the processes of pages and channels apart, and forgets a page that is gone', () => {
    const { bridge, events } = makeOutputBridge();
    const one = fakeWebview('one', 'claudeVSCodePanel');
    const two = fakeWebview('two', 'claudeVSCodePanel');
    bridge.observeToWebview(one, init('c', 'S1'));
    bridge.observeToWebview(two, init('c', 'S2'));
    bridge.observeToWebview(two, reply('c'));
    bridge.observeToWebview(one, reply('c'));
    bridge.didDisposeWebview(one);
    // Its process is forgotten: a reply without a session id names nothing.
    bridge.observeToWebview(one, reply('c'));
    assert.deepEqual(events, ['started S1', 'started S2', 'used S2', 'used S1']);
  });

  test('a reply on a channel whose start it missed starts its session there', () => {
    const { bridge, events } = makeOutputBridge();
    bridge.observeToWebview(fakeWebview('panel', 'claudeVSCodePanel'), reply('c1', 'S1'));
    assert.deepEqual(events, ['started S1', 'used S1']);
  });
});
