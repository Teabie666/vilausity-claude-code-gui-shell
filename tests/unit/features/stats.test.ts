import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../../../src/platform/format';
import { formatInteger } from '../../../src/platform/format';
import {
  formatCost,
  formatFactor,
  funCostDrinks,
  funLinesPages,
  funOutputPages,
  funTypedChars,
  heatLevel,
  totalTokens,
} from '../../../src/features/stats/statsView';

describe('stats formatting', () => {
  test('formatInteger groups thousands', () => {
    assert.equal(formatInteger(0), '0');
    assert.equal(formatInteger(999), '999');
    assert.equal(formatInteger(1000), '1,000');
    assert.equal(formatInteger(1234567), '1,234,567');
  });

  test('formatBytes picks the largest unit above 1', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(493568), '482 KB');
    assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
  });

  test('formatFactor is an integer or one decimal', () => {
    assert.equal(formatFactor(1), '1');
    assert.equal(formatFactor(3.75), '3.8');
    assert.equal(formatFactor(0.1), '0.1');
    assert.equal(formatFactor(150.4), '150');
    assert.equal(formatFactor(1234.5), '1,235');
  });

  test('formatCost keeps two decimals', () => {
    assert.equal(formatCost(3.7), '3.70');
    assert.equal(formatCost(15), '15.00');
  });

  test('heatLevel maps to five steps', () => {
    assert.equal(heatLevel(0, 100), 0);
    assert.equal(heatLevel(0, 0), 0);
    assert.equal(heatLevel(1, 100), 1);
    assert.equal(heatLevel(25, 100), 1);
    assert.equal(heatLevel(50, 100), 2);
    assert.equal(heatLevel(100, 100), 4);
  });

  test('totalTokens sums the four counters', () => {
    assert.equal(totalTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10);
  });
});

describe('fun conversions', () => {
  test('typed characters use the language-specific divisor', () => {
    assert.equal(funTypedChars(880_000, 'zh-cn'), '1');
    assert.equal(funTypedChars(270_000, 'en'), '1');
    assert.equal(funTypedChars(88_000, 'zh-cn'), '0.1');
    assert.equal(funTypedChars(10_000, 'en'), undefined);
  });

  test('output pages', () => {
    assert.equal(funOutputPages(1_000), '1');
    assert.equal(funOutputPages(3_500), '3.5');
    assert.equal(funOutputPages(50), undefined);
  });

  test('lines as printed pages', () => {
    assert.equal(funLinesPages(50), '1');
    assert.equal(funLinesPages(125), '2.5');
    assert.equal(funLinesPages(4), undefined);
  });

  test('cost as drinks by currency', () => {
    assert.equal(funCostDrinks(15, 'CNY'), '1');
    assert.equal(funCostDrinks(5, 'USD'), '1');
    assert.equal(funCostDrinks(1, 'CNY'), undefined);
  });
});
