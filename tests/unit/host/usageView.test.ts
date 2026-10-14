import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { formatCost, formatTokens, usageTotal, usageView } from '../../../src/host/main/usageView';
import type { ProviderPricing } from '../../../src/platform/providers';
import type { ModelTokens, UsageScopes } from '../../../src/platform/usage';

const tokens = (input: number, output = 0, cacheRead = 0, cacheWrite = 0, calls = 1): ModelTokens[string] => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  calls,
});

const PRICING: ProviderPricing = { currency: 'CNY', models: { 'deepseek-flash': { input: 2, output: 8, cacheRead: 0.2 } } };

describe('formatCost', () => {
  test('writes the currency, two decimals, and a floor for what rounds to nothing', () => {
    assert.equal(formatCost(0, 'CNY'), '¥0');
    assert.equal(formatCost(0.004, 'CNY'), '<¥0.01');
    assert.equal(formatCost(3.456, 'USD'), '$3.46');
    assert.equal(formatCost(1234.5, 'CNY'), '¥1234.50');
  });
});

describe('formatTokens', () => {
  test('writes token counts the way the extension does', () => {
    assert.equal(formatTokens(950), '950');
    assert.equal(formatTokens(36_087), '36.1k');
    assert.equal(formatTokens(1_200_000), '1.2m');
  });
});

describe('usageView', () => {
  const scopes = (session: ModelTokens, folder: ModelTokens, all: ModelTokens): UsageScopes => ({ session, folder, all });

  test('prices each scope and says by model what went into it', () => {
    const used = { 'deepseek-flash': tokens(1_000_000, 1_000_000, 1_000_000, 0, 3) };
    const view = usageView(scopes(used, used, used), 'DeepSeek', PRICING, true);
    assert.equal(view.title, 'Usage · DeepSeek');
    assert.deepEqual(
      view.rows.map((row) => [row.label, row.value]),
      [
        ['This conversation', '¥10.20'],
        ['This workspace', '¥10.20'],
        ['Claude Code history', '¥10.20'],
      ],
    );
    assert.equal(view.rows[0]?.detail, 'deepseek-flash: 1m input, 1m output, 1m cache read, 0 cache write (3 calls) · ¥10.20');
    assert.equal(view.unpriced, undefined);
    // Always said: some calls Claude Code makes keep no usage record.
    assert.equal(view.caveat, "This version's figures can be a little lower than what the API charges.");
  });

  test('a scope with models that have no price is a lower bound, or a dash when none has one', () => {
    const priced = { 'deepseek-flash': tokens(1_000_000) };
    const both = { ...priced, 'deepseek-v4': tokens(5) };
    const unpriced = { 'deepseek-v4': tokens(5) };
    const view = usageView(scopes(unpriced, both, both), 'DeepSeek', PRICING, true);
    assert.deepEqual(
      view.rows.map((row) => row.value),
      ['—', '≥ ¥2.00', '≥ ¥2.00'],
    );
    assert.equal(view.unpriced, 'No price for deepseek-v4');
    assert.match(view.rows[1]?.detail ?? '', /deepseek-v4: .* · no price/);
  });

  test('no conversation in front is a dash; nothing used is nothing spent', () => {
    const view = usageView(scopes({}, {}, {}), 'DeepSeek', undefined, false);
    assert.deepEqual(
      view.rows.map((row) => [row.value, row.detail]),
      [
        ['—', 'Nothing yet'],
        ['$0', 'Nothing yet'],
        ['$0', 'Nothing yet'],
      ],
    );
  });
});

describe('usageTotal', () => {
  test("a provider's total: its cost, a lower bound with unpriced models, and the models in the detail", () => {
    const priced = usageTotal({ 'deepseek-flash': tokens(1_000_000, 1_000_000, 1_000_000, 0, 3) }, PRICING);
    assert.equal(priced.value, '¥10.20');
    assert.ok(priced.detail.startsWith('deepseek-flash: '), priced.detail);
    const partly = usageTotal({ 'deepseek-flash': tokens(1_000_000), other: tokens(5) }, PRICING);
    assert.equal(partly.value, '≥ ¥2.00');
    assert.equal(usageTotal({ other: tokens(5) }, PRICING).value, '—');
    assert.equal(usageTotal({}, PRICING).value, '¥0');
  });
});
