import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { findQuote } from '../../../src/host/webview/conversationQuotes';

describe('findQuote', () => {
  test('finds the quote where it is', () => {
    assert.deepEqual(findQuote('Apples are red or green.', 'red or', 0), { start: 11, end: 17 });
  });

  test('takes white space loosely: line breaks the page text lacks, or has where the selection has one', () => {
    // A selection across paragraphs reads "green.\n\nThe end"; the page's text may join them.
    assert.deepEqual(findQuote('or green.The end', 'green.\n\nThe end', 0), { start: 3, end: 16 });
    assert.deepEqual(findQuote('one item\n  two item', 'one item two', 0), { start: 0, end: 14 });
  });

  test('of several occurrences, takes the one nearest to where the quote was', () => {
    const text = 'red. Apples are red. Pears are red.';
    assert.equal(findQuote(text, 'red', 0)?.start, 0);
    assert.equal(findQuote(text, 'red', 17)?.start, 16);
    assert.equal(findQuote(text, 'red', 40)?.start, 31);
  });

  test('takes characters that mean something in a regular expression as they are', () => {
    assert.deepEqual(findQuote('call f(a[0]) + 1? $x', 'f(a[0]) + 1? $x', 0), { start: 5, end: 20 });
  });

  test('finds nothing for a quote that is not there, or blank', () => {
    assert.equal(findQuote('Apples are red.', 'pears', 0), undefined);
    assert.equal(findQuote('Apples are red.', ' \n ', 0), undefined);
  });
});
