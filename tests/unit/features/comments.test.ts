import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { basename, COLLAPSE_ABOVE, commentsView, QUOTE_LIMIT, sourceLabel } from '../../../src/features/comments/view';
import { countLineBreaks, lineMarker, locateLines, plainMarkdownLine } from '../../../src/features/markdown/sourceLines';
import type { ConversationCommentDto, ConversationPlaceDto, FileCommentDto, RangeDto } from '../../../src/platform/protocol';

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

describe('commentsView', () => {
  test('returns null for no comments', () => {
    assert.equal(commentsView([]), null);
  });

  test('orders blocks newest first', () => {
    const view = commentsView([comment('c1'), comment('c2'), comment('c3')])!;
    assert.deepEqual(
      view.blocks.map((b) => b.id),
      ['c3', 'c2', 'c1'],
    );
  });

  test('collapses only when there are more than COLLAPSE_ABOVE comments', () => {
    const atLimit = Array.from({ length: COLLAPSE_ABOVE }, (_, index) => comment(`c${index}`));
    const over = [...atLimit, comment('extra')];
    assert.equal(commentsView(atLimit)!.collapsed, false);
    assert.equal(commentsView(over)!.collapsed, true);
  });

  test('labels the header with the count', () => {
    assert.equal(commentsView([comment('c1')])!.labels.header, '1 comment');
    assert.equal(commentsView([comment('c1'), comment('c2'), comment('c3')])!.labels.header, '3 comments');
  });

  test('shows the file name and line as the source', () => {
    const c = comment('c1', {
      path: 'C:\\work\\proj\\src\\a.ts',
      range: { start: { line: 11, character: 0 }, end: { line: 11, character: 5 } },
    });
    assert.equal(commentsView([c])!.blocks[0]!.source, 'a.ts:12');
  });

  test('flattens the quote and cuts it to QUOTE_LIMIT', () => {
    const flattened = commentsView([comment('c1', { quote: 'a\n  b' })])!.blocks[0]!.quote;
    assert.equal(flattened, 'a b');

    const long = commentsView([comment('c1', { quote: 'x'.repeat(QUOTE_LIMIT + 10) })])!.blocks[0]!.quote;
    assert.equal(long, `${'x'.repeat(QUOTE_LIMIT - 1)}…`);
    assert.equal(long.length, QUOTE_LIMIT);
  });

  test('sets the source tooltip to the full path', () => {
    const c = comment('c1', { path: 'C:\\work\\proj\\src\\a.ts' });
    assert.equal(commentsView([c])!.blocks[0]!.sourceTitle, 'Go to C:\\work\\proj\\src\\a.ts:1');
  });

  test("names whose words commented text of the conversation is, and lists it to highlight; file comments' text is not", () => {
    const said = (id: string, role: ConversationPlaceDto['role']): ConversationCommentDto => ({
      kind: 'conversation',
      id,
      quote: `quote ${id}`,
      text: `note ${id}`,
      place: { role, uuid: role === 'user' ? undefined : `uuid-${id}`, turn: 2, offset: 5 },
    });
    const view = commentsView([said('c1', 'reply'), comment('c2'), said('c3', 'thinking'), said('c4', 'user')])!;
    assert.deepEqual(
      view.blocks.map((block) => [block.id, block.source, block.sourceTitle]),
      [
        ['c4', 'Your message', 'Show in the conversation'],
        ['c3', "Claude's thinking", 'Show in the conversation'],
        ['c2', 'c2.ts:1', 'Go to C:\\work\\proj\\c2.ts:1'],
        ['c1', "Claude's reply", 'Show in the conversation'],
      ],
    );
    assert.deepEqual(view.quotes, [
      { quote: 'quote c1', place: { role: 'reply', uuid: 'uuid-c1', turn: 2, offset: 5 } },
      { quote: 'quote c3', place: { role: 'thinking', uuid: 'uuid-c3', turn: 2, offset: 5 } },
      { quote: 'quote c4', place: { role: 'user', uuid: undefined, turn: 2, offset: 5 } },
    ]);
    assert.deepEqual(commentsView([comment('c5')])!.quotes, []);
  });
});

describe('sourceLabel and basename', () => {
  test('basename keeps the last segment for both separators', () => {
    assert.equal(basename('C:\\work\\proj\\a.ts'), 'a.ts');
    assert.equal(basename('/work/proj/a.ts'), 'a.ts');
    assert.equal(basename('a.ts'), 'a.ts');
  });

  test('sourceLabel combines the file name with the line span', () => {
    const range: RangeDto = { start: { line: 11, character: 2 }, end: { line: 14, character: 5 } };
    assert.equal(sourceLabel('C:\\work\\proj\\a.ts', range), 'a.ts:12-15');
    assert.equal(sourceLabel('/work/proj/a.ts', range), 'a.ts:12-15');
    assert.equal(sourceLabel('a.ts', { start: { line: 3, character: 0 }, end: { line: 3, character: 2 } }), 'a.ts:4');
  });
});

describe('plainMarkdownLine', () => {
  test('strips headings, quotes, list and task markers', () => {
    assert.equal(plainMarkdownLine('## Title'), 'Title');
    assert.equal(plainMarkdownLine('> quoted'), 'quoted');
    assert.equal(plainMarkdownLine('- item'), 'item');
    assert.equal(plainMarkdownLine('1. item'), 'item');
    assert.equal(plainMarkdownLine('- [x] done'), 'done');
  });

  test('removes emphasis, code and strike-through marks', () => {
    assert.equal(plainMarkdownLine('**bold**'), 'bold');
    assert.equal(plainMarkdownLine('`code`'), 'code');
    assert.equal(plainMarkdownLine('~~del~~'), 'del');
    assert.equal(plainMarkdownLine('_em_'), 'em');
  });

  test('keeps link and image text, drops tags and turns pipes into spaces', () => {
    assert.equal(plainMarkdownLine('[text](url)'), 'text');
    assert.equal(plainMarkdownLine('![alt](src)'), 'alt');
    assert.equal(plainMarkdownLine('<b>hi</b>'), 'hi');
    assert.equal(plainMarkdownLine('a | b'), 'a b');
  });

  test('collapses runs of whitespace into single spaces', () => {
    assert.equal(plainMarkdownLine('  a   b  '), 'a b');
  });
});

describe('countLineBreaks and lineMarker', () => {
  test('countLineBreaks counts line feed characters', () => {
    assert.equal(countLineBreaks('a\nb\nc'), 2);
    assert.equal(countLineBreaks('no breaks'), 0);
  });

  test('lineMarker wraps the source line in its data attribute', () => {
    assert.equal(lineMarker(12), '<span hidden data-source-line="12"></span>');
  });
});

describe('locateLines', () => {
  // A block's `line` is the source line of its first raw line.
  test('maps a single-line selection to its source line', () => {
    const block = { line: 10, raw: 'line one\nline two\nline three' };
    assert.deepEqual(locateLines(block, 'line two'), { start: 11, end: 11, endLength: 'line two'.length });
  });

  test('spans a soft-wrapped paragraph across its source lines', () => {
    const block = { line: 20, raw: 'first part\nsecond part' };
    assert.deepEqual(locateLines(block, 'first part\nsecond part'), {
      start: 20,
      end: 21,
      endLength: 'second part'.length,
    });
  });

  test('finds a selection inside formatted source', () => {
    const block = { line: 5, raw: '**refactor** the parser' };
    assert.deepEqual(locateLines(block, 'refactor the parser'), {
      start: 5,
      end: 5,
      endLength: '**refactor** the parser'.length,
    });
  });

  test('falls back to the first line when the selection is not found', () => {
    const block = { line: 10, raw: 'line one\nline two' };
    assert.deepEqual(locateLines(block, 'not present'), { start: 10, end: 10, endLength: 'line one'.length });
  });

  test('does not let a trailing empty line become the end', () => {
    const block = { line: 30, raw: 'first\nsecond\n' };
    assert.deepEqual(locateLines(block, 'first\nsecond\nmissing'), { start: 30, end: 31, endLength: 'second'.length });
  });
});
