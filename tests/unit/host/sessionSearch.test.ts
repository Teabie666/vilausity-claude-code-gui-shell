import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { claudeProjectsDir, SessionIndex } from '../../../src/host/main/sessionSearch';
import {
  displayPath,
  indexSession,
  parseTranscript,
  passage,
  searchSessions,
  type IndexedSession,
} from '../../../src/host/main/sessionTranscripts';

const FOLDER = 'C:\\work\\shop';
const line = (value: unknown): string => JSON.stringify(value);
const user = (content: unknown, extra: Record<string, unknown> = {}): string =>
  line({ type: 'user', cwd: FOLDER, message: { role: 'user', content }, ...extra });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}): string =>
  line({ type: 'assistant', cwd: FOLDER, message: { role: 'assistant', content }, ...extra });

function session(id: string, lines: string[], updatedAt: number, sideTitle?: string): IndexedSession {
  const indexed = indexSession(id, parseTranscript(lines.join('\n')), updatedAt, sideTitle);
  assert.ok(indexed, `${id} is indexed`);
  return indexed;
}

describe('parseTranscript', () => {
  test('keeps what was typed and answered, not context, tool output or the CLI’s own messages', () => {
    const transcript = parseTranscript(
      [
        user([
          { type: 'text', text: '<ide_opened_file>The user opened src/a.ts</ide_opened_file>' },
          { type: 'text', text: '  Rename the cart total  ' },
        ]),
        user('<command-name>/compact</command-name>'),
        user('Caveat: summary', { isMeta: true }),
        user('This session continues…', { isCompactSummary: true }),
        user([{ type: 'tool_result', content: 'file contents' }], { toolUseResult: { stdout: '' } }),
        assistant([
          { type: 'thinking', thinking: 'secret plan' },
          { type: 'text', text: 'Renamed it in cart.ts.' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\work\\shop\\src\\cart.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\work\\shop\\src\\cart.ts' } },
          { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\work\\shop\\README.md' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ]),
        assistant([{ type: 'text', text: 'side chain' }], { isSidechain: true }),
        'not json',
        line({ type: 'ai-title', aiTitle: 'Old name' }),
        line({ type: 'ai-title', aiTitle: 'Cart total rename' }),
        line({ type: 'something-new', value: 1 }),
      ].join('\n'),
    );
    assert.equal(transcript.cwd, FOLDER);
    assert.equal(transcript.aiTitle, 'Cart total rename');
    assert.equal(transcript.customTitle, undefined);
    assert.deepEqual(transcript.messages, [
      { role: 'user', text: 'Rename the cart total' },
      { role: 'assistant', text: 'Renamed it in cart.ts.' },
    ]);
    assert.deepEqual(transcript.files, [
      { path: 'C:\\work\\shop\\src\\cart.ts', edited: true },
      { path: 'C:\\work\\shop\\README.md', edited: false },
    ]);
  });
});

describe('indexSession', () => {
  test('title: the user’s name, then the side file’s, then the generated one, then the first prompt', () => {
    const prompt = user('Fix   the\nlogin page');
    const custom = line({ type: 'custom-title', customTitle: 'Login' });
    const ai = line({ type: 'ai-title', aiTitle: 'Login page fix' });
    assert.equal(session('a', [prompt, ai, custom], 1, 'Side').title, 'Login');
    assert.equal(session('b', [prompt, ai], 1, 'Side').title, 'Side');
    assert.equal(session('c', [prompt, ai], 1).title, 'Login page fix');
    assert.equal(session('d', [prompt], 1).title, 'Fix the login page');
  });

  test('skips sessions with nothing said, or no folder', () => {
    assert.equal(indexSession('e', parseTranscript(line({ type: 'mode', mode: 'x' })), 1), undefined);
    assert.equal(indexSession('f', parseTranscript(line({ type: 'user', message: { content: 'hi' } })), 1), undefined);
  });
});

describe('searchSessions', () => {
  const sessions = [
    session('old', [user('Sort the PDFs in Downloads by month'), line({ type: 'ai-title', aiTitle: 'Tidy downloads' })], 100),
    session(
      'new',
      [
        user('Make the 标签页 look right'),
        assistant([
          { type: 'text', text: 'Changed the tab styles.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\work\\shop\\src\\styles.css' } },
        ]),
        line({ type: 'ai-title', aiTitle: 'Tab look' }),
      ],
      200,
    ),
    session('pdf', [user('Read this'), line({ type: 'ai-title', aiTitle: 'PDF reader' })], 50),
  ];

  test('an empty query lists the newest first', () => {
    assert.deepEqual(
      searchSessions(sessions, '', 2).map((result) => result.sessionId),
      ['new', 'old'],
    );
  });

  test('title matches come before files and content, each newest first', () => {
    const results = searchSessions(sessions, 'PDF', 10);
    assert.deepEqual(
      results.map((result) => [result.sessionId, result.match?.kind]),
      [
        ['pdf', 'title'],
        ['old', 'content'],
      ],
    );
    assert.deepEqual(results[0]?.match, { kind: 'title', highlights: [[0, 3]] });
  });

  test('a file match shows the path inside the folder, with either slash typed', () => {
    const match = searchSessions(sessions, 'src/STYLES', 10)[0]?.match;
    assert.deepEqual(match, { kind: 'file', text: 'src/styles.css', highlights: [[0, 10]], edited: true });
  });

  test('content matches anywhere, Chinese too, with the passage around it', () => {
    const match = searchSessions(sessions, '标签页', 10)[0]?.match;
    assert.equal(match?.kind, 'content');
    assert.ok(match?.kind === 'content');
    assert.equal(match.role, 'user');
    assert.equal(match.text, 'Make the 标签页 look right');
    assert.deepEqual(match.highlights, [[9, 12]]);
  });
});

describe('passage', () => {
  test('cuts long text around the match and marks the cuts', () => {
    const text = `${'a'.repeat(100)}NEEDLE\n${'b'.repeat(300)}`;
    const result = passage(text, 100, 6);
    assert.ok(result.text.startsWith('…'));
    assert.ok(result.text.endsWith('…'));
    assert.ok(!result.text.includes('\n'));
    const [start, end] = result.highlights[0]!;
    assert.equal(result.text.slice(start, end), 'NEEDLE');
  });
});

describe('displayPath', () => {
  test('relative inside the folder, whole outside it', () => {
    assert.equal(displayPath('c:\\Work\\Shop\\src\\a.ts', FOLDER), 'src/a.ts');
    assert.equal(displayPath('D:\\other\\b.ts', FOLDER), 'D:/other/b.ts');
  });
});

describe('SessionIndex', () => {
  test('reads the transcripts of a folder, and rereads one that changed', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vilaus-sessions-'));
    try {
      const project = path.join(dir, 'C--work-shop');
      mkdirSync(project);
      const file = path.join(project, 's1.jsonl');
      writeFileSync(file, [user('First question'), line({ type: 'ai-title', aiTitle: 'One' })].join('\n'));
      writeFileSync(path.join(project, 'notes.txt'), 'not a transcript');
      const index = new SessionIndex(dir);
      const first = await index.search({ query: '', folder: 'c:\\work\\shop', limit: 10 });
      assert.deepEqual(
        first.map((result) => result.title),
        ['One'],
      );
      assert.deepEqual(await index.search({ query: '', folder: 'C:\\elsewhere', limit: 10 }), []);

      writeFileSync(file, [user('First question'), line({ type: 'custom-title', customTitle: 'Renamed' })].join('\n'));
      const later = new Date(Date.now() + 60_000);
      utimesSync(file, later, later);
      // Within the rescan interval the index answers from what it read...
      assert.equal((await index.search({ query: '', limit: 10 }))[0]?.title, 'One');
      // ...a new index (or a later search) reads the change.
      assert.equal((await new SessionIndex(dir).search({ query: '', limit: 10 }))[0]?.title, 'Renamed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the transcripts folder follows CLAUDE_CONFIG_DIR; VILAUS_SESSIONS_DIR overrides it', () => {
    assert.equal(claudeProjectsDir({}, 'C:\\Users\\me'), path.join('C:\\Users\\me', '.claude', 'projects'));
    assert.equal(claudeProjectsDir({ CLAUDE_CONFIG_DIR: 'D:\\cfg' }, 'C:\\Users\\me'), path.join('D:\\cfg', 'projects'));
    assert.equal(claudeProjectsDir({ VILAUS_SESSIONS_DIR: 'E:\\t' }, 'C:\\Users\\me'), 'E:\\t');
  });
});
