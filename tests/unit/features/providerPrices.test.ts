import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePrices, type PriceDraft } from '../../../src/features/providers/providerForm';

const draft = (input: string, output: string, cacheRead = '', cacheWrite = ''): PriceDraft => ({ input, output, cacheRead, cacheWrite });

describe('parsePrices', () => {
  test('keeps the models given prices; empty cache prices are left out, empty rows dropped', () => {
    assert.deepEqual(
      parsePrices({
        'deepseek-flash': draft(' 2 ', '8', '0.2'),
        'deepseek-v4': draft('', ''),
      }),
      { models: { 'deepseek-flash': { input: 2, output: 8, cacheRead: 0.2, cacheWrite: undefined } }, bad: [] },
    );
  });

  test('names the models whose prices do not parse', () => {
    const parsed = parsePrices({
      'no-output': draft('2', ''),
      negative: draft('-1', '2'),
      words: draft('two', '2'),
      'bad-cache': draft('1', '2', 'x'),
      zero: draft('0', '0'),
    });
    assert.deepEqual(parsed.bad, ['no-output', 'negative', 'words', 'bad-cache']);
    assert.deepEqual(parsed.models, { zero: { input: 0, output: 0, cacheRead: undefined, cacheWrite: undefined } });
  });
});
