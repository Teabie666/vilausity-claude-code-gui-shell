import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { flattenQuote, isComment, lineSpan, linesLabel } from '../../../src/platform/comments';

describe('lineSpan', () => {
  test('returns the same 1-based line for a single-line range', () => {
    assert.deepEqual(lineSpan({ start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }), {
      start: 3,
      end: 3,
    });
  });

  test('returns the first and last line for a multi-line range', () => {
    assert.deepEqual(lineSpan({ start: { line: 0, character: 3 }, end: { line: 2, character: 7 } }), {
      start: 1,
      end: 3,
    });
  });

  test('ends on the last fully selected line when the selection ends at a line start', () => {
    assert.deepEqual(lineSpan({ start: { line: 1, character: 0 }, end: { line: 3, character: 0 } }), {
      start: 2,
      end: 3,
    });
  });

  test('a zero-width selection stays on its own line', () => {
    assert.deepEqual(lineSpan({ start: { line: 4, character: 5 }, end: { line: 4, character: 5 } }), {
      start: 5,
      end: 5,
    });
  });
});

describe('linesLabel', () => {
  test('shows a single line number for a one-line range', () => {
    assert.equal(linesLabel({ start: { line: 11, character: 0 }, end: { line: 11, character: 3 } }), '12');
  });

  test('shows start-end for a multi-line range', () => {
    assert.equal(linesLabel({ start: { line: 11, character: 2 }, end: { line: 14, character: 5 } }), '12-15');
  });
});

describe('flattenQuote', () => {
  test('collapses line breaks and whitespace runs into single spaces and trims', () => {
    assert.equal(flattenQuote('  a\nb   c\n', 100), 'a b c');
    assert.equal(flattenQuote('a\t b\n\nc', 100), 'a b c');
    assert.equal(flattenQuote('  hi  ', 100), 'hi');
  });

  test('keeps a short quote unchanged', () => {
    assert.equal(flattenQuote('hello world', 100), 'hello world');
  });

  test('cuts a long quote to the limit, ending in an ellipsis', () => {
    assert.equal(flattenQuote('abcdefghijk', 10), 'abcdefghi…');
    assert.equal(flattenQuote('abcdefghijk', 10).length, 10);
  });
});

describe('isComment', () => {
  const valid = {
    id: 'c1',
    quote: 'selected text',
    uri: 'file:///C:/work/proj/a.ts',
    path: 'C:\\work\\proj\\a.ts',
    text: 'a note',
    range: { start: { line: 0, character: 2 }, end: { line: 1, character: 0 } },
  };

  test('accepts a well-formed comment', () => {
    assert.equal(isComment(valid), true);
  });

  test('rejects a comment missing a field', () => {
    assert.equal(isComment({ id: 'c1', quote: 'x', uri: 'u', path: 'p', range: valid.range }), false);
  });

  test('rejects a comment with a field of the wrong type', () => {
    assert.equal(isComment({ ...valid, text: 42 }), false);
    assert.equal(isComment({ ...valid, id: 7 }), false);
  });

  test('rejects a range with negative or fractional positions', () => {
    assert.equal(isComment({ ...valid, range: { start: { line: -1, character: 0 }, end: { line: 1, character: 0 } } }), false);
    assert.equal(isComment({ ...valid, range: { start: { line: 0, character: 0.5 }, end: { line: 1, character: 0 } } }), false);
  });

  test('rejects null, arrays and strings', () => {
    assert.equal(isComment(null), false);
    assert.equal(isComment([]), false);
    assert.equal(isComment('comment'), false);
  });

  test("accepts a file comment marked as one, and rejects a kind it doesn't know", () => {
    assert.equal(isComment({ ...valid, kind: 'file' }), true);
    assert.equal(isComment({ ...valid, kind: 'note' }), false);
  });

  describe('on text of the conversation', () => {
    const conversation = {
      kind: 'conversation',
      id: 'c2',
      quote: 'Apples are red',
      text: 'Not all of them',
      place: { role: 'reply', uuid: 'a1', turn: 0, offset: 7 },
    };

    test('accepts the three roles, the user message without a uuid', () => {
      assert.equal(isComment(conversation), true);
      assert.equal(isComment({ ...conversation, place: { ...conversation.place, role: 'thinking' } }), true);
      assert.equal(isComment({ ...conversation, place: { role: 'user', turn: 2, offset: 0 } }), true);
    });

    test('rejects a missing or malformed place', () => {
      const { place: _place, ...withoutPlace } = conversation;
      assert.equal(isComment(withoutPlace), false);
      assert.equal(isComment({ ...conversation, place: { ...conversation.place, role: 'tool' } }), false);
      assert.equal(isComment({ ...conversation, place: { ...conversation.place, uuid: 3 } }), false);
      assert.equal(isComment({ ...conversation, place: { ...conversation.place, turn: -1 } }), false);
      assert.equal(isComment({ ...conversation, place: { ...conversation.place, offset: 1.5 } }), false);
    });

    test('does not take a file comment for one: the kind decides', () => {
      assert.equal(isComment({ ...valid, kind: 'conversation' }), false);
    });
  });
});
