import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  codeBlock,
  ENGLISH_LABELS,
  escapeHtml,
  inlineCode,
  SHOWN_LINES,
  transcriptMarkdown,
} from '../../../src/host/main/transcriptMarkdown';

type Entry = Record<string, unknown>;

const FOLDER = 'C:\\work';
const BASE = Date.UTC(2026, 9, 24, 10, 0, 0);

let nextUuid = 0;
let nextMinute = 0;

/** A transcript as Claude Code writes it: one record a line, each parentUuid the one before. */
function transcript(entries: readonly (Entry | string)[]): string {
  const out: string[] = [];
  let parent: string | null = null;
  for (const item of entries) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    const given = item['uuid'];
    const uuid = typeof given === 'string' ? given : `uuid-${++nextUuid}`;
    const entry: Entry = {
      timestamp: new Date(BASE + 60_000 * nextMinute++).toISOString(),
      cwd: FOLDER,
      ...item,
      uuid,
    };
    if (!('parentUuid' in item)) {
      entry['parentUuid'] = parent;
    }
    parent = uuid;
    out.push(`${JSON.stringify(entry)}\n`);
  }
  return out.join('');
}

/** UTC, so a test's timestamps read the same wherever it runs. */
const formatTime = (time: Date, withDate: boolean): string =>
  withDate ? `D ${time.toISOString().slice(11, 16)}` : time.toISOString().slice(11, 16);

function render(text: string, extra: { title?: string; sessionId?: string; subagents?: ReadonlyMap<string, string> } = {}): string {
  return transcriptMarkdown(text, {
    title: 'Test session',
    sessionId: 'sess-1',
    labels: ENGLISH_LABELS,
    formatTime,
    ...extra,
  });
}

const user = (content: unknown, extra: Entry = {}): Entry => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
});

const assistant = (content: unknown[], extra: Entry = {}): Entry => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  ...extra,
});

const result = (id: string, content: unknown, isError = false): Entry =>
  user([{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]);

describe('transcriptMarkdown', () => {
  test('the user and Claude, one Claude heading for a reply of several blocks, the date only on the first', () => {
    const md = render(
      transcript([
        user('Rename the total', { timestamp: '2026-10-24T10:00:00.000Z' }),
        assistant(
          [
            { type: 'text', text: 'Done.' },
            { type: 'text', text: 'Twice.' },
          ],
          {
            timestamp: '2026-10-24T10:05:00.000Z',
          },
        ),
        assistant([{ type: 'text', text: 'And a third.' }], { timestamp: '2026-10-24T10:06:00.000Z' }),
      ]),
    );
    assert.match(md, /## You · D 10:00/);
    assert.ok(md.includes('Rename the total'));
    assert.match(md, /### Claude · 10:05/);
    assert.ok(!md.includes('### Claude · D'), 'the same day is not stamped again');
    assert.equal(md.match(/### Claude/g)?.length, 1);
    assert.ok(md.includes('Done.') && md.includes('Twice.') && md.includes('And a third.'));
  });

  test('thinking folds away', () => {
    const md = render(transcript([user('Think about it'), assistant([{ type: 'thinking', thinking: 'Weigh the options.' }])]));
    assert.ok(md.indexOf('<details>') > md.indexOf('### Claude'));
    assert.match(md, /<details>\n<summary>Thinking<\/summary>\n\nWeigh the options\.\n\n<\/details>/);
  });

  test('a tool call and its result, an error, and a call with no result', () => {
    const md = render(
      transcript([
        assistant([
          { type: 'text', text: 'Listing.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ]),
        result('t1', 'a\nb'),
        assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pwd' } }]),
        result('t2', 'C:\\work'),
        assistant([{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'false' } }]),
        result('t3', 'a\nb', true),
        assistant([{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'sleep 9' } }]),
      ]),
    );
    assert.match(md, /\*\*Bash\*\* `ls`/);
    assert.match(md, /<summary>Result · 2 lines<\/summary>\n\n```\na\nb\n```/);
    assert.match(md, /<summary>Result · 1 line<\/summary>/);
    assert.match(md, /<summary>Error · 2 lines<\/summary>/);
    assert.ok(md.includes('*No result*'));
  });

  test('a long result keeps the first lines and says how many were cut', () => {
    const many = Array.from({ length: SHOWN_LINES + 3 }, (_, index) => `line ${index + 1}`).join('\n');
    const md = render(
      transcript([assistant([{ type: 'tool_use', id: 'big', name: 'Bash', input: { command: 'seq' } }]), result('big', many)]),
    );
    assert.ok(md.includes(`<summary>Result · ${SHOWN_LINES + 3} lines</summary>`), 'the summary counts them all');
    assert.ok(md.includes(`line ${SHOWN_LINES}\n`));
    assert.ok(!md.includes(`line ${SHOWN_LINES + 1}`));
    assert.match(md, /\*3 more lines\*/);
  });

  test('Edit as a diff, Write as its content, TodoWrite as a list, ExitPlanMode open, other tools as JSON', () => {
    const md = render(
      transcript([
        user('Do several things'),
        assistant([
          {
            type: 'tool_use',
            id: 'edit-1',
            name: 'Edit',
            input: { file_path: 'src/cart.ts', old_string: 'old line', new_string: 'new line' },
          },
          {
            type: 'tool_use',
            id: 'write-1',
            name: 'Write',
            input: { file_path: 'notes.txt', content: '# Notes\nhello' },
          },
          {
            type: 'tool_use',
            id: 'todos-1',
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'buy milk', status: 'completed' },
                { content: 'call mom', status: 'in_progress' },
              ],
            },
          },
          { type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: { plan: '# Plan\n- step' } },
          { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'needle', path: 'src' } },
        ]),
      ]),
    );
    assert.match(md, /\*\*Edit\*\* `src\/cart\.ts`/);
    assert.match(md, /<summary>Input<\/summary>\n\n```diff\n-old line\n\+new line\n```/);
    assert.ok(md.includes('```\n# Notes\nhello\n```'));
    assert.ok(md.includes('- [x] buy milk'));
    assert.ok(md.includes('- [ ] call mom'));
    assert.match(md, /<details open>\n<summary>Plan<\/summary>\n\n# Plan\n- step\n\n<\/details>/);
    assert.match(md, /\*\*Grep\*\* `needle`/);
    assert.ok(md.includes('"path": "src"'), 'the rest of the input is JSON');
    assert.ok(!md.includes('"pattern"'), 'the argument already on the line is not repeated');
  });

  test('the argument on the line goes by its key: another with the same value stays in the input', () => {
    const md = render(
      transcript([assistant([{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls', description: 'ls' } }]), result('b', '')]),
    );
    assert.match(md, /\*\*Bash\*\* `ls`/);
    assert.ok(md.includes('"description": "ls"'));
    assert.ok(!md.includes('"command"'));
  });

  test('a subagent’s reply folds under its call, before the call’s result, with no headings of its own', () => {
    const subagent = transcript([user('SUBAGENT PROMPT, not shown'), assistant([{ type: 'text', text: 'Subagent answer.' }])]);
    const md = render(
      transcript([
        user('Look around'),
        assistant([{ type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Explore the repo' } }]),
        result('task-1', 'Agent finished.'),
      ]),
      { subagents: new Map([['task-1', subagent]]) },
    );
    assert.ok(md.includes('Subagent answer.'));
    assert.ok(!md.includes('SUBAGENT PROMPT'));
    const call = md.indexOf('**Task**');
    const fold = md.indexOf('<summary>Subagent</summary>');
    const after = md.indexOf('<summary>Result · 1 line</summary>');
    assert.ok(call >= 0 && fold >= 0 && after >= 0);
    assert.ok(call < fold && fold < after);
    assert.equal(md.match(/## You/g)?.length, 1);
    assert.equal(md.match(/### Claude/g)?.length, 1);
  });

  test('broken and empty lines are skipped, the rest is kept', () => {
    const md = render(
      transcript([user('first'), 'not json\n', '\n', '{"type":"user","uuid":\n', 'null\n', assistant([{ type: 'text', text: 'second' }])]),
    );
    assert.ok(md.includes('first'));
    assert.ok(md.includes('second'));
    assert.ok(!md.includes('not json'));
  });

  test('the latest branch after a rewind, and across compaction', () => {
    const branch = render(
      transcript([
        user('the question', { uuid: 'q', parentUuid: null }),
        assistant([{ type: 'text', text: 'abandoned answer' }], { uuid: 'old', parentUuid: 'q' }),
        assistant([{ type: 'text', text: 'kept answer' }], { uuid: 'new', parentUuid: 'q' }),
      ]),
    );
    assert.ok(branch.includes('the question'));
    assert.ok(branch.includes('kept answer'));
    assert.ok(!branch.includes('abandoned answer'));

    const compacted = render(
      transcript([
        user('before compaction', { uuid: 'c1', parentUuid: null, timestamp: '2026-10-24T10:00:00.000Z' }),
        assistant([{ type: 'text', text: 'answer before' }], {
          uuid: 'c2',
          parentUuid: 'c1',
          timestamp: '2026-10-24T10:01:00.000Z',
        }),
        {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'c3',
          parentUuid: null,
          logicalParentUuid: 'c2',
          timestamp: '2026-10-24T10:02:00.000Z',
        },
        user('the summary of it all', {
          uuid: 'c4',
          parentUuid: 'c3',
          isCompactSummary: true,
          timestamp: '2026-10-24T10:03:00.000Z',
        }),
        user('after compaction', { uuid: 'c5', parentUuid: 'c4', timestamp: '2026-10-24T10:04:00.000Z' }),
      ]),
    );
    assert.ok(compacted.includes('answer before'));
    assert.ok(compacted.includes('the summary of it all'));
    assert.match(compacted, /\*Conversation compacted · 10:02\*/);
    assert.ok(compacted.includes('<summary>Summary</summary>'));
    const before = compacted.indexOf('answer before');
    const mark = compacted.indexOf('Conversation compacted');
    const summary = compacted.indexOf('<summary>Summary</summary>');
    const after = compacted.indexOf('after compaction');
    assert.ok(before >= 0 && before < mark);
    assert.ok(mark < summary && summary < after);
  });

  test('context the CLI adds is left out, a slash command is shown as one, an image is marked', () => {
    const md = render(
      transcript([
        user([{ type: 'text', text: '<system-reminder>stay on task</system-reminder>' }]),
        user([{ type: 'text', text: '<ide_opened_file>The user opened src/a.ts</ide_opened_file>' }]),
        user('Caveat: meta text', { isMeta: true }),
        user('<command-name>/compact</command-name><command-args>x</command-args>'),
        user([
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ]),
      ]),
    );
    assert.ok(!md.includes('stay on task'));
    assert.ok(!md.includes('src/a.ts'));
    assert.ok(!md.includes('meta text'));
    assert.ok(md.includes('`/compact x`'));
    assert.ok(md.includes('what is this?'));
    assert.ok(md.includes('*[Image]*'));
    assert.equal(md.match(/## You/g)?.length, 2);
  });

  test('the title, then the session id and the first cwd', () => {
    const md = render(transcript([user('hi', { cwd: undefined }), assistant([{ type: 'text', text: 'hello' }], { cwd: 'D:\\other' })]), {
      title: '  My   session  ',
      sessionId: 'sess-1',
    });
    assert.ok(md.startsWith('# My session\n\n'));
    assert.ok(md.includes('`sess-1` · `D:\\other`'));
    assert.ok(!md.includes('`C:\\work`'));
  });
});

describe('escapeHtml', () => {
  test('a tag in what was said becomes text, code keeps it', () => {
    assert.equal(escapeHtml('see <details> here'), 'see &lt;details> here');
    assert.equal(escapeHtml('code `<b>` inline'), 'code `<b>` inline');
    assert.equal(escapeHtml('```\n<b>\n```'), '```\n<b>\n```');
    assert.equal(escapeHtml('a ` <div>'), 'a ` &lt;div>', 'an unclosed span does not stop the escaping');
  });
});

describe('codeBlock and inlineCode', () => {
  test('a fence is longer than any run in the text', () => {
    const fenced = codeBlock('a\n```\nb');
    assert.ok(fenced.startsWith('````\n'));
    assert.ok(fenced.endsWith('\n````'));
    assert.equal(codeBlock('x'), '```\nx\n```');
    assert.equal(codeBlock('x', 'json'), '```json\nx\n```');
  });

  test('inline code: longer ticks, one line, cut at 200 characters', () => {
    assert.equal(inlineCode('a `b` c'), '``a `b` c``');
    assert.equal(inlineCode('two\n  lines'), '`two lines`');
    assert.equal(inlineCode('x'.repeat(250)), `\`${'x'.repeat(200)}…\``);
    // Not through an emoji (two code units) that the cut falls in.
    assert.equal(inlineCode(`${'x'.repeat(199)}😀😀`), `\`${'x'.repeat(199)}…\``);
  });
});
