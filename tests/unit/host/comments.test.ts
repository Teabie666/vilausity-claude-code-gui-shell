import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { StorageBackend } from '../../../src/compat/vscode/host';
import {
  CommentStore,
  ConversationComments,
  displayPath,
  formatComments,
  sanitizeComments,
  type CommentPanels,
} from '../../../src/host/exthost/comments';
import { Emitter, Event } from '../../../src/platform/event';
import type { ConversationCommentDto, ConversationPlaceDto, FileCommentDto } from '../../../src/platform/protocol';

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

function track(source: { onDidChange: CommentStore['onDidChange'] }): string[] {
  const changed: string[] = [];
  source.onDidChange((id) => {
    changed.push(id);
  });
  return changed;
}

/** Open panels whose webview state is a session id, or undefined before the page names one. */
class FakePanels implements CommentPanels {
  allPanels: { webview: { id: string; state: unknown } }[] = [];
  private readonly emitter = new Emitter<void>();
  readonly onDidChangePanels = this.emitter.event;

  open(id: string, session?: string): { webview: { id: string; state: unknown } } {
    const panel = { webview: { id, state: session as unknown } };
    this.allPanels.push(panel);
    this.emitter.fire();
    return panel;
  }

  close(id: string): void {
    this.allPanels = this.allPanels.filter((panel) => panel.webview.id !== id);
    this.emitter.fire();
  }

  /** The page saves a state naming a session (WebviewManager fires for every state). */
  showSession(id: string, session: string | undefined): void {
    this.allPanels.find((panel) => panel.webview.id === id)!.webview.state = session;
    this.emitter.fire();
  }
}

const sessionOf = (state: unknown): string | undefined => (typeof state === 'string' ? state : undefined);

function setup(saved?: unknown) {
  const panels = new FakePanels();
  const writes: unknown[] = [];
  const storage: StorageBackend = {
    initial: () => (saved === undefined ? {} : { 'vilaus.comments': saved }),
    set: (_scope, key, value) => {
      if (key === 'vilaus.comments') {
        writes.push(value);
      }
    },
    onDidChange: Event.None,
  };
  const comments = new ConversationComments(panels, sessionOf, storage);
  const ids = (webviewId: string): string[] => comments.list(webviewId).map((c) => c.id);
  return { panels, comments, writes, ids };
}

describe('CommentStore', () => {
  test('add keeps one comment per id', () => {
    const store = new CommentStore();
    store.add('w1', comment('c1'));
    store.add('w1', comment('c1'));
    assert.deepEqual(
      store.list('w1').map((c) => c.id),
      ['c1'],
    );
  });

  test('update fires a change only when the text actually differs', () => {
    const store = new CommentStore();
    store.add('w1', comment('c1', { text: 'old' }));
    const changed = track(store);
    store.update('w1', 'c1', 'old');
    assert.deepEqual(changed, []);
    store.update('w1', 'c1', 'new');
    assert.deepEqual(changed, ['w1']);
    assert.equal(store.list('w1')[0]!.text, 'new');
  });

  test('remove drops the listed ids and fires only when something was removed', () => {
    const store = new CommentStore();
    store.add('w1', comment('c1'));
    store.add('w1', comment('c2'));
    const changed = track(store);
    store.remove('w1', ['c2']);
    assert.deepEqual(changed, ['w1']);
    assert.deepEqual(
      store.list('w1').map((c) => c.id),
      ['c1'],
    );
    store.remove('w1', ['c2']);
    assert.deepEqual(changed, ['w1']);
  });

  test("set replaces a conversation's comments and clears them when given an empty list", () => {
    const store = new CommentStore();
    store.add('w1', comment('c1'));
    const changed = track(store);
    store.set('w1', [comment('c2'), comment('c3')]);
    assert.deepEqual(changed, ['w1']);
    assert.deepEqual(
      store.list('w1').map((c) => c.id),
      ['c2', 'c3'],
    );
    store.set('w1', []);
    assert.deepEqual(changed, ['w1', 'w1']);
    assert.deepEqual(store.list('w1'), []);
  });

  test('take returns the comments and empties the webview', () => {
    const store = new CommentStore();
    store.add('w1', comment('c1'));
    store.add('w1', comment('c2'));
    assert.deepEqual(
      store.take('w1').map((c) => c.id),
      ['c1', 'c2'],
    );
    assert.deepEqual(store.list('w1'), []);
  });

  test('add appends several at once, skips ids already there, and says whether any were new', () => {
    const store = new CommentStore();
    store.add('w1', comment('c1'));
    const changed = track(store);
    assert.equal(store.add('w1', comment('c1'), comment('c2'), comment('c2'), comment('c3')), true);
    assert.deepEqual(
      store.list('w1').map((c) => c.id),
      ['c1', 'c2', 'c3'],
    );
    assert.deepEqual(changed, ['w1']);
    assert.equal(store.add('w1', comment('c2')), false);
    assert.equal(store.add('w1'), false);
    assert.deepEqual(changed, ['w1']);
  });

  test('keys lists the keys that have comments', () => {
    const store = new CommentStore();
    store.add('w1', comment('c1'));
    store.add('w2', comment('c2'));
    store.take('w1');
    assert.deepEqual(store.keys(), ['w2']);
  });

  test('list returns an empty array for an unknown webview', () => {
    assert.deepEqual(new CommentStore().list('missing'), []);
  });

  test('onDidChange does not fire when nothing changed', () => {
    const store = new CommentStore();
    const changed = track(store);
    store.set('w1', []);
    store.update('w1', 'c1', 'new');
    store.remove('w1', ['c1']);
    assert.deepEqual(changed, []);
  });
});

describe('sanitizeComments', () => {
  test('returns an empty array for a non-array value', () => {
    assert.deepEqual(sanitizeComments(undefined), []);
    assert.deepEqual(sanitizeComments('x'), []);
    assert.deepEqual(sanitizeComments({}), []);
    assert.deepEqual(sanitizeComments(null), []);
  });

  test('drops malformed entries and keeps the well-formed ones', () => {
    const good = comment('c1');
    assert.deepEqual(sanitizeComments([good, 42, null, 'x', { id: 'c2' }]), [good]);
  });
});

describe('displayPath', () => {
  test('shows a path inside the workspace relative to it, with slash separators', () => {
    assert.equal(displayPath('C:\\work\\proj\\src\\a.ts', ['C:\\work\\proj']), 'src/a.ts');
  });

  test('keeps a path outside the workspace unchanged', () => {
    assert.equal(displayPath('C:\\other\\b.ts', ['C:\\work\\proj']), 'C:\\other\\b.ts');
  });

  test('uses the workspace folder that contains the file', () => {
    assert.equal(displayPath('C:\\work\\proj\\sub\\c.ts', ['C:\\work\\proj\\other', 'C:\\work\\proj\\sub']), 'c.ts');
  });

  test('keeps the file as-is when it is the workspace folder itself', () => {
    assert.equal(displayPath('C:\\work\\proj', ['C:\\work\\proj']), 'C:\\work\\proj');
  });
});

describe('formatComments', () => {
  test('builds the header and one trimmed paragraph per comment, quotes flattened', () => {
    const comments = [
      comment('c1', {
        quote: 'first\n line',
        path: 'C:\\work\\proj\\src\\a.ts',
        text: '  use a Map  ',
        range: { start: { line: 11, character: 0 }, end: { line: 11, character: 9 } },
      }),
      comment('c2', {
        quote: 'second',
        path: 'C:\\work\\proj\\src\\b.ts',
        text: 'note',
        range: { start: { line: 11, character: 2 }, end: { line: 14, character: 5 } },
      }),
    ];
    assert.equal(
      formatComments(comments, ['C:\\work\\proj']),
      'Comments on selected text:\n\n' + '[Re: "first line" — src/a.ts:12] use a Map\n\n' + '[Re: "second" — src/b.ts:12-15] note',
    );
  });

  test('cuts a quote longer than 200 characters to 200 with an ellipsis', () => {
    const c = comment('c1', { quote: 'x'.repeat(250) });
    assert.equal(formatComments([c], ['C:\\work\\proj']), `Comments on selected text:\n\n[Re: "${'x'.repeat(199)}…" — c1.ts:1] note c1`);
  });

  test("says whose words commented text of the conversation is, in the user's words, among file comments", () => {
    const said = (id: string, role: ConversationPlaceDto['role'], quote: string, text: string): ConversationCommentDto => ({
      kind: 'conversation',
      id,
      quote,
      text,
      place: { role, uuid: role === 'user' ? undefined : `uuid-${id}`, turn: 1, offset: 0 },
    });
    const comments = [
      said('c1', 'reply', 'Apples are\nred', 'Not all of them.'),
      comment('c2', { quote: 'const a', path: 'C:\\work\\proj\\a.ts' }),
      said('c3', 'thinking', 'check the tests', 'Yes, do.'),
      said('c4', 'user', 'topic 3', 'I meant topic 4.'),
    ];
    assert.equal(
      formatComments(comments, ['C:\\work\\proj']),
      'Comments on selected text:\n\n' +
        '[Re: "Apples are red" — your earlier reply] Not all of them.\n\n' +
        '[Re: "const a" — a.ts:1] note c2\n\n' +
        '[Re: "check the tests" — your earlier thinking] Yes, do.\n\n' +
        '[Re: "topic 3" — my earlier message] I meant topic 4.',
    );
  });
});

describe('ConversationComments', () => {
  test("keeps a session's comments when its panel closes and shows them where the session opens next", () => {
    const { panels, comments, ids } = setup();
    panels.open('w1', 'S1');
    comments.add('w1', comment('c1'));
    panels.close('w1');
    assert.deepEqual(ids('w1'), []);
    panels.open('w2');
    const changed = track(comments);
    assert.deepEqual(ids('w2'), []);
    panels.showSession('w2', 'S1');
    assert.deepEqual(ids('w2'), ['c1']);
    assert.deepEqual(changed, ['w2']);
  });

  test("a new conversation's comments wait on its panel and go to the session it gets, with one change", () => {
    const { panels, comments, writes, ids } = setup();
    panels.open('w1');
    comments.add('w1', comment('c1'));
    assert.deepEqual(
      comments.unsessioned('w1').map((c) => c.id),
      ['c1'],
    );
    assert.deepEqual(writes, []);
    const changed = track(comments);
    panels.showSession('w1', 'S1');
    assert.deepEqual(changed, ['w1']);
    assert.deepEqual(ids('w1'), ['c1']);
    assert.deepEqual(comments.unsessioned('w1'), []);
    assert.deepEqual(writes.at(-1), { S1: [comment('c1')] });
    panels.close('w1');
    panels.open('w2', 'S1');
    assert.deepEqual(ids('w2'), ['c1']);
  });

  test('closing a panel that has no session drops its comments', () => {
    const { panels, comments, writes, ids } = setup();
    panels.open('w1');
    comments.add('w1', comment('c1'));
    panels.close('w1');
    panels.open('w1');
    assert.deepEqual(ids('w1'), []);
    assert.deepEqual(writes, []);
  });

  test("loads the sessions' comments from workspace storage and writes every change back", () => {
    const { panels, comments, writes, ids } = setup({ S1: [comment('c1'), 'junk'], S2: 'junk' });
    panels.open('w1', 'S1');
    panels.open('w2', 'S2');
    assert.deepEqual(ids('w1'), ['c1']);
    assert.deepEqual(ids('w2'), []);
    comments.add('w2', comment('c2'));
    assert.deepEqual(writes.at(-1), { S1: [comment('c1')], S2: [comment('c2')] });
    assert.deepEqual(
      comments.take('w1').map((c) => c.id),
      ['c1'],
    );
    assert.deepEqual(writes.at(-1), { S2: [comment('c2')] });
  });

  test("a panel that moves to another session shows that session's comments and leaves the first one's", () => {
    const { panels, comments, ids } = setup();
    panels.open('w1', 'S1');
    comments.add('w1', comment('c1'));
    const changed = track(comments);
    panels.showSession('w1', 'S2');
    assert.deepEqual(ids('w1'), []);
    panels.showSession('w1', 'S1');
    assert.deepEqual(ids('w1'), ['c1']);
    assert.deepEqual(changed, ['w1', 'w1']);
  });

  test('panels on one session share its comments and both hear of changes', () => {
    const { panels, comments, ids } = setup();
    panels.open('w1', 'S1');
    panels.open('w2', 'S1');
    const changed = track(comments);
    comments.add('w1', comment('c1'));
    assert.deepEqual(changed.sort(), ['w1', 'w2']);
    assert.deepEqual(ids('w2'), ['c1']);
    comments.update('w2', 'c1', 'edited');
    assert.equal(comments.list('w1')[0]!.text, 'edited');
    comments.remove('w1', ['c1']);
    assert.deepEqual(ids('w2'), []);
  });

  test('ignores webviews that are no panel', () => {
    const { comments, ids } = setup();
    assert.equal(comments.add('nope', comment('c1')), false);
    assert.deepEqual(ids('nope'), []);
    assert.deepEqual(comments.take('nope'), []);
  });

  test('restore puts comments saved with a panel into the session its state names, else back on the panel', () => {
    const { panels, comments, writes } = setup();
    // A restored panel gets its state assigned without an event.
    panels.open('w1').webview.state = 'S1';
    comments.restore('w1', [comment('c1')]);
    assert.deepEqual(
      comments.list('w1').map((c) => c.id),
      ['c1'],
    );
    assert.deepEqual(comments.unsessioned('w1'), []);
    assert.deepEqual(writes.at(-1), { S1: [comment('c1')] });
    panels.open('w2');
    comments.restore('w2', [comment('c2')]);
    assert.deepEqual(
      comments.unsessioned('w2').map((c) => c.id),
      ['c2'],
    );
  });
});
