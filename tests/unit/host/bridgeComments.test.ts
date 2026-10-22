import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeWebviewBridge } from '../../../src/host/exthost/bridge';
import { CommentStore, formatComments } from '../../../src/host/exthost/comments';
import { NullLogger } from '../../../src/platform/log';
import { CHAT_PANEL_VIEW_TYPE, type WebviewImpl } from '../../../src/compat/vscode/webviews';
import type { OsBackend } from '../../../src/compat/vscode/host';
import type { FileCommentDto } from '../../../src/platform/protocol';

function comment(id: string, overrides: Partial<FileCommentDto> = {}): FileCommentDto {
  return {
    id,
    quote: `quote ${id}`,
    uri: `file:///C:/work/proj/${id}.ts`,
    path: `C:\\work\\proj\\${id}.ts`,
    text: `note ${id}`,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    ...overrides,
  };
}

function makeWebview(id: string, viewType: string): WebviewImpl {
  return {
    id,
    viewType,
    postMessage(_message: unknown) {
      return Promise.resolve(true);
    },
  } as unknown as WebviewImpl;
}

function makeOs(): OsBackend {
  return {
    openExternal: async () => true,
    clipboardRead: async () => '',
    clipboardWrite: async () => {},
  };
}

function makeBridge(comments: CommentStore, workspaceFolders: string[]) {
  const bridge = new ClaudeWebviewBridge(makeOs(), NullLogger, {
    diffEditorAvailable: () => false,
    comments,
    workspaceFolders,
  });
  return { bridge };
}

function ioMessage(content: unknown) {
  return {
    type: 'io_message',
    channelId: 'c1',
    done: false,
    message: {
      type: 'user',
      uuid: 'u1',
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content },
    },
  };
}

describe('ClaudeWebviewBridge comment attachment', () => {
  test("attaches a conversation's comments as a final text block and clears them", () => {
    const store = new CommentStore();
    const c1 = comment('c1');
    const c2 = comment('c2');
    store.add('w1', c1);
    store.add('w1', c2);
    const { bridge } = makeBridge(store, ['C:\\work\\proj']);
    const webview = makeWebview('w1', CHAT_PANEL_VIEW_TYPE);
    const content = [{ type: 'text', text: '你好' }];
    const message = ioMessage(content);

    assert.equal(bridge.interceptFromWebview(webview, message), false);
    assert.deepEqual(message.message.message.content, [
      { type: 'text', text: '你好' },
      { type: 'text', text: formatComments([c1, c2], ['C:\\work\\proj']) },
    ]);
    assert.deepEqual(store.list('w1'), []);
  });

  test('leaves the message unchanged when there are no comments', () => {
    const store = new CommentStore();
    const { bridge } = makeBridge(store, ['C:\\work\\proj']);
    const webview = makeWebview('w1', CHAT_PANEL_VIEW_TYPE);
    const content = [{ type: 'text', text: '你好' }];
    const message = ioMessage(content);

    assert.equal(bridge.interceptFromWebview(webview, message), false);
    assert.deepEqual(message.message.message.content, content);
  });

  test('does not attach to a slash command and keeps the comments', () => {
    const store = new CommentStore();
    store.add('w1', comment('c1'));
    const { bridge } = makeBridge(store, ['C:\\work\\proj']);
    const webview = makeWebview('w1', CHAT_PANEL_VIEW_TYPE);
    const content = [{ type: 'text', text: '  /compact' }];
    const message = ioMessage(content);

    assert.equal(bridge.interceptFromWebview(webview, message), false);
    assert.deepEqual(message.message.message.content, content);
    assert.deepEqual(
      store.list('w1').map((c) => c.id),
      ['c1'],
    );
  });

  test('converts string content into a text block plus the comments block', () => {
    const store = new CommentStore();
    const c1 = comment('c1');
    store.add('w1', c1);
    const { bridge } = makeBridge(store, ['C:\\work\\proj']);
    const webview = makeWebview('w1', CHAT_PANEL_VIEW_TYPE);
    const message = ioMessage('你好');

    assert.equal(bridge.interceptFromWebview(webview, message), false);
    assert.deepEqual(message.message.message.content, [
      { type: 'text', text: '你好' },
      { type: 'text', text: formatComments([c1], ['C:\\work\\proj']) },
    ]);
    assert.deepEqual(store.list('w1'), []);
  });

  test('does not touch a non-user message and keeps the comments', () => {
    const store = new CommentStore();
    store.add('w1', comment('c1'));
    const { bridge } = makeBridge(store, ['C:\\work\\proj']);
    const webview = makeWebview('w1', CHAT_PANEL_VIEW_TYPE);
    const content = [{ type: 'text', text: 'hi' }];
    const message = {
      type: 'io_message',
      channelId: 'c1',
      done: false,
      message: { type: 'assistant', message: { role: 'assistant', content } },
    };

    assert.equal(bridge.interceptFromWebview(webview, message), false);
    assert.equal(message.message.message.content, content);
    assert.deepEqual(
      store.list('w1').map((c) => c.id),
      ['c1'],
    );
  });

  test("clears only the sending webview's comments", () => {
    const store = new CommentStore();
    store.add('w1', comment('c1'));
    store.add('w2', comment('c2'));
    const { bridge } = makeBridge(store, ['C:\\work\\proj']);
    const webview = makeWebview('w1', CHAT_PANEL_VIEW_TYPE);
    const message = ioMessage([{ type: 'text', text: '你好' }]);

    bridge.interceptFromWebview(webview, message);
    assert.deepEqual(store.list('w1'), []);
    assert.deepEqual(
      store.list('w2').map((c) => c.id),
      ['c2'],
    );
  });

  test('pageHints anchors comments only for conversation panels', () => {
    const store = new CommentStore();
    const { bridge } = makeBridge(store, []);
    const panel = makeWebview('p1', CHAT_PANEL_VIEW_TYPE);
    const other = makeWebview('o1', 'someOtherView');

    const hints = bridge.pageHints(panel);
    assert.ok(hints !== undefined);
    assert.equal(typeof hints.commentsAnchor, 'string');
    assert.ok((hints.commentsAnchor ?? '').length > 0);
    assert.equal(bridge.pageHints(other), undefined);
  });

  test('pageHints mark the content of the pages whose UI is translated, and no other page', () => {
    const { bridge } = makeBridge(new CommentStore(), []);
    const conversation = bridge.pageHints(makeWebview('p1', CHAT_PANEL_VIEW_TYPE))?.untranslated ?? '';
    const sessionList = bridge.pageHints(makeWebview('v1', 'claudeVSCodeSessionsList'))?.untranslated ?? '';
    const planPreview = bridge.pageHints(makeWebview('p2', 'claudePlanPreview'))?.untranslated ?? '';
    assert.ok(conversation.includes('[aria-label="Claude Code conversation"]'));
    assert.equal(sessionList, conversation);
    assert.ok(planPreview.includes('#content'));
    assert.equal(bridge.pageHints(makeWebview('o1', 'someOtherView'))?.untranslated, undefined);
  });
});
