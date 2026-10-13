import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTokens,
  attributeCall,
  attributedProvider,
  costOf,
  inferProvider,
  lastProvider,
  modelsUsed,
  sessionUsageByProvider,
  summarizeUsage,
  totalCost,
  type AttributedProvider,
  type ModelTokens,
  type SessionTag,
  type SessionUsage,
  type TokenCounts,
  type UsageCall,
  type UsageQuery,
  type UsageSnapshot,
  unrecordedCalls,
} from '../../../src/platform/usage';
import { modelKey, parseProviderConfig, type ProviderConfig, type ProviderPricing } from '../../../src/platform/providers';

// Attribution only ever sees the subscription as one more provider, always present.
const subscription: AttributedProvider = { id: 'subscription', type: 'subscription', models: [] };
const deepseek: AttributedProvider = { id: 'deepseek', type: 'compatible', models: ['deepseek-flash'] };

const tag = (provider: string, at: number, name: string = provider): SessionTag => ({ provider, name, at });

const call = (model: string, at: number, tokens: Partial<TokenCounts> = {}): UsageCall => ({
  model,
  at,
  input: tokens.input ?? 0,
  output: tokens.output ?? 0,
  cacheRead: tokens.cacheRead ?? 0,
  cacheWrite: tokens.cacheWrite ?? 0,
});

describe('modelKey', () => {
  test('trims, lowercases and drops a trailing bracketed suffix', () => {
    assert.equal(modelKey('  DeepSeek-Flash[1m]  '), 'deepseek-flash');
  });

  test('keeps a bracket in the middle of the name', () => {
    assert.equal(modelKey('foo[1m]bar'), 'foo[1m]bar');
  });
});

describe('parseProviderConfig pricing', () => {
  test('normalizes the model keys and keeps only the price fields given', () => {
    const parsed = parseProviderConfig({
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'compatible',
      pricing: { currency: 'CNY', models: { 'DeepSeek-Flash[1m]': { input: 2, output: 3, cacheRead: 0.2 } } },
    });
    assert.deepEqual(parsed?.pricing, {
      currency: 'CNY',
      models: { 'deepseek-flash': { input: 2, output: 3, cacheRead: 0.2 } },
    });
  });

  test('a currency other than CNY becomes USD', () => {
    const usd = parseProviderConfig({
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'compatible',
      pricing: { currency: 'USD', models: { m: { input: 1, output: 1 } } },
    });
    assert.equal(usd?.pricing?.currency, 'USD');
    const unknown = parseProviderConfig({
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'compatible',
      pricing: { currency: 'EUR', models: { m: { input: 1, output: 1 } } },
    });
    assert.equal(unknown?.pricing?.currency, 'USD');
  });

  test('drops bad prices, rows missing a price, and empty model names', () => {
    const parsed = parseProviderConfig({
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'compatible',
      pricing: {
        currency: 'CNY',
        models: {
          good: { input: 1, output: 2 },
          negative: { input: -1, output: 2 },
          nan: { input: NaN, output: 2 },
          string: { input: '1', output: 2 },
          'no-output': { input: 1 },
          'no-input': { output: 2 },
          '   ': { input: 1, output: 2 },
        },
      },
    });
    assert.deepEqual(parsed?.pricing?.models, {
      good: { input: 1, output: 2 },
    });
  });

  test('no pricing field leaves pricing undefined', () => {
    const parsed = parseProviderConfig({ id: 'deepseek', name: 'DeepSeek', type: 'compatible' });
    assert.equal(parsed?.pricing, undefined);
  });
});

describe('costOf', () => {
  test('prices per million tokens', () => {
    const tokens: TokenCounts = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    assert.equal(costOf(tokens, { input: 2, output: 3 }), 2);
  });

  test('cache prices default to the input price', () => {
    const tokens: TokenCounts = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
    assert.equal(costOf(tokens, { input: 2, output: 3 }), 4);
  });

  test('given cache prices win over the input price', () => {
    const tokens: TokenCounts = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
    assert.equal(costOf(tokens, { input: 2, output: 3, cacheRead: 0.25, cacheWrite: 0.5 }), 0.75);
  });
});

describe('totalCost', () => {
  test('sums the priced models and lists the unpriced ones, sorted', () => {
    const models: ModelTokens = {
      'a-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
      'b-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
      'c-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1 },
    };
    const pricing: ProviderPricing = {
      currency: 'CNY',
      models: { 'a-model': { input: 2, output: 3 }, 'b-model': { input: 4, output: 5 } },
    };
    assert.deepEqual(totalCost(models, pricing), { cost: 6, unpriced: ['c-model'] });
  });

  test('without pricing every model is unpriced and the cost is zero', () => {
    const models: ModelTokens = {
      'b-model': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1 },
      'a-model': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, calls: 1 },
    };
    assert.deepEqual(totalCost(models, undefined), { cost: 0, unpriced: ['a-model', 'b-model'] });
  });
});

describe('inferProvider', () => {
  test('the one compatible API that names the model', () => {
    const providers: AttributedProvider[] = [subscription, deepseek];
    assert.equal(inferProvider('deepseek-flash', providers), 'deepseek');
  });

  test('two compatible APIs naming it make it ambiguous', () => {
    const providers: AttributedProvider[] = [
      subscription,
      { id: 'deepseek', type: 'compatible', models: ['deepseek-flash'] },
      { id: 'deepseek-2', type: 'compatible', models: ['deepseek-flash'] },
    ];
    assert.equal(inferProvider('deepseek-flash', providers), undefined);
  });

  test('a non-compatible API naming a model does not name it', () => {
    const providers: AttributedProvider[] = [subscription, { id: 'anthropic', type: 'anthropic-api', models: ['deepseek-flash'] }];
    assert.equal(inferProvider('deepseek-flash', providers), undefined);
  });

  test('a claude model with only the subscription goes to it', () => {
    assert.equal(inferProvider('claude-opus-5-5', [subscription]), 'subscription');
    assert.equal(inferProvider('us.anthropic.claude-opus-5-5', [subscription]), 'subscription');
  });

  test('a claude model with another Anthropic-style API is ambiguous', () => {
    const providers: AttributedProvider[] = [subscription, { id: 'anthropic', type: 'anthropic-api', models: [] }];
    assert.equal(inferProvider('claude-opus-5-5', providers), undefined);
  });

  test('a model nobody names and that is not claude is undefined', () => {
    assert.equal(inferProvider('deepseek-v4-alias', [subscription]), undefined);
  });
});

describe('attributeCall', () => {
  test('with no tag the call is put down to the model alone', () => {
    assert.equal(attributeCall({ model: 'deepseek-flash', at: 100 }, [], [subscription, deepseek]), 'deepseek');
  });

  test('a call earlier than every tag is inferred', () => {
    assert.equal(attributeCall({ model: 'claude-opus-5-5', at: 50 }, [tag('deepseek', 100)], [subscription, deepseek]), 'subscription');
  });

  test('the tag in force is the latest one at or before the call', () => {
    const providers: AttributedProvider[] = [
      subscription,
      { id: 'a', type: 'compatible', models: ['m'] },
      { id: 'b', type: 'compatible', models: ['m'] },
    ];
    const tags = [tag('a', 100), tag('b', 200)];
    assert.equal(attributeCall({ model: 'm', at: 150 }, tags, providers), 'a');
    assert.equal(attributeCall({ model: 'm', at: 250 }, tags, providers), 'b');
  });

  test('a call under a removed provider stays with it', () => {
    assert.equal(attributeCall({ model: 'm', at: 150 }, [tag('gone', 100)], [subscription]), 'gone');
  });

  test('the tag wins when its provider knows the model, even if another compatible does too', () => {
    const providers: AttributedProvider[] = [
      subscription,
      { id: 'deepseek', type: 'compatible', models: ['deepseek-flash'] },
      { id: 'deepseek-2', type: 'compatible', models: ['deepseek-flash'] },
    ];
    assert.equal(attributeCall({ model: 'deepseek-flash', at: 150 }, [tag('deepseek', 100)], providers), 'deepseek');
  });

  test('a compatible provider with no models of its own keeps a claude model', () => {
    const providers: AttributedProvider[] = [subscription, { id: 'deepseek', type: 'compatible', models: [] }];
    assert.equal(attributeCall({ model: 'claude-opus-5-5', at: 150 }, [tag('deepseek', 100)], providers), 'deepseek');
  });

  test('a Claude model its provider does not name stays with the tag: only a name another API gives moves it', () => {
    assert.equal(attributeCall({ model: 'claude-opus-5-5', at: 150 }, [tag('deepseek', 100)], [subscription, deepseek]), 'deepseek');
  });

  test('a model one other compatible API names takes the call from the tag (the session went on elsewhere)', () => {
    assert.equal(attributeCall({ model: 'deepseek-flash', at: 150 }, [tag('subscription', 100)], [subscription, deepseek]), 'deepseek');
  });

  test('a gateway answering an alias with the model it stands for keeps its calls', () => {
    const openrouter: AttributedProvider = { id: 'openrouter', type: 'compatible', models: ['~anthropic/claude-opus-latest'] };
    const providers = [subscription, openrouter];
    assert.equal(attributeCall({ model: 'anthropic/claude-opus-5', at: 150 }, [tag('openrouter', 100)], providers), 'openrouter');
    // Untagged, a gateway's name for a Claude model is no Claude model of the subscription's.
    assert.equal(attributeCall({ model: 'anthropic/claude-opus-5', at: 150 }, [], providers), undefined);
  });

  test('a model nobody knows stays with its tag (an alias the API answered with)', () => {
    assert.equal(attributeCall({ model: 'deepseek-v4-alias', at: 150 }, [tag('deepseek', 100)], [subscription, deepseek]), 'deepseek');
  });

  test('a claude call tagged subscription stays there when the inference is ambiguous', () => {
    const providers: AttributedProvider[] = [subscription, { id: 'anthropic', type: 'anthropic-api', models: [] }];
    assert.equal(attributeCall({ model: 'claude-opus-5-5', at: 150 }, [tag('subscription', 100)], providers), 'subscription');
  });

  test('the call model is normalized before it is matched', () => {
    assert.equal(attributeCall({ model: ' DeepSeek-Flash ', at: 1 }, [], [subscription, deepseek]), 'deepseek');
  });
});

describe('attributedProvider', () => {
  test('joins the model fields and the priced models, normalized and deduplicated', () => {
    const provider: ProviderConfig = {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'compatible',
      models: { main: 'deepseek-flash[1m]', haiku: 'deepseek-flash', subagent: 'DeepSeek-Flash' },
      pricing: {
        currency: 'CNY',
        models: { 'deepseek-flash': { input: 2, output: 3 }, 'deepseek-v4': { input: 4, output: 5 } },
      },
    };
    assert.deepEqual(attributedProvider(provider), { id: 'deepseek', type: 'compatible', models: ['deepseek-flash', 'deepseek-v4'] });
  });

  test('with neither models nor pricing the list is empty', () => {
    assert.deepEqual(attributedProvider({ id: 'x', name: '', type: 'compatible' }), { id: 'x', type: 'compatible', models: [] });
  });
});

describe('summarizeUsage', () => {
  test('adds up by model in the session, folder and all scopes', () => {
    const providers: AttributedProvider[] = [subscription, deepseek];
    const tagsBySession: Record<string, SessionTag[]> = {
      s1: [tag('deepseek', 0)],
      s2: [tag('subscription', 0)],
      s3: [tag('deepseek', 0)],
    };
    const sessions: SessionUsage[] = [
      {
        sessionId: 's1',
        folder: 'C:\\work',
        calls: [call('deepseek-flash', 100, { input: 100, output: 10 }), call('deepseek-flash', 200, { input: 50, output: 5 })],
      },
      { sessionId: 's2', folder: 'C:\\work', calls: [call('claude-opus-5-5', 100, { input: 1000, output: 100 })] },
      { sessionId: 's3', folder: 'C:\\other', calls: [call('deepseek-flash', 100, { input: 10, output: 1 })] },
    ];
    const query: UsageQuery = { provider: 'deepseek', sessionId: 's1', inFolder: (folder) => folder === 'C:\\work' };
    assert.deepEqual(
      summarizeUsage(sessions, (id) => tagsBySession[id] ?? [], providers, query),
      {
        session: { 'deepseek-flash': { input: 150, output: 15, cacheRead: 0, cacheWrite: 0, calls: 2 } },
        folder: { 'deepseek-flash': { input: 150, output: 15, cacheRead: 0, cacheWrite: 0, calls: 2 } },
        all: { 'deepseek-flash': { input: 160, output: 16, cacheRead: 0, cacheWrite: 0, calls: 3 } },
      },
    );
  });

  test('without an inFolder test the folder scope is empty, and folder-less sessions never count there', () => {
    const providers: AttributedProvider[] = [subscription, deepseek];
    const tagsBySession: Record<string, SessionTag[]> = {
      s1: [tag('deepseek', 0)],
      s2: [tag('deepseek', 0)],
    };
    const sessions: SessionUsage[] = [
      { sessionId: 's1', folder: undefined, calls: [call('deepseek-flash', 100, { input: 10, output: 1 })] },
      { sessionId: 's2', folder: 'C:\\work', calls: [call('deepseek-flash', 100, { input: 5, output: 0 })] },
    ];

    const withoutFolder = summarizeUsage(sessions, (id) => tagsBySession[id] ?? [], providers, { provider: 'deepseek' });
    assert.deepEqual(withoutFolder.folder, {});
    assert.equal(withoutFolder.all['deepseek-flash']?.input, 15);

    const withFolder = summarizeUsage(sessions, (id) => tagsBySession[id] ?? [], providers, {
      provider: 'deepseek',
      inFolder: () => true,
    });
    assert.equal(withFolder.folder['deepseek-flash']?.input, 5);
  });

  test('a call copied into a forked conversation counts once, in the session it is first come to', () => {
    const providers: AttributedProvider[] = [subscription, deepseek];
    const copied = { ...call('deepseek-flash', 100, { input: 100 }), id: 'msg-1' };
    const sessions: SessionUsage[] = [
      { sessionId: 'original', folder: 'C:\\work', calls: [copied] },
      // The fork starts with the original's calls, then goes on (and has one line twice).
      {
        sessionId: 'fork',
        folder: 'C:\\work',
        calls: [
          copied,
          { ...call('deepseek-flash', 200, { input: 10 }), id: 'msg-2' },
          { ...call('deepseek-flash', 200, { input: 10 }), id: 'msg-2' },
        ],
      },
    ];
    const scopes = (sessionId: string) =>
      summarizeUsage(sessions, () => [], providers, { provider: 'deepseek', sessionId, inFolder: () => true });
    assert.equal(scopes('fork').session['deepseek-flash']?.input, 10);
    assert.equal(scopes('original').session['deepseek-flash']?.input, 100);
    assert.equal(scopes('fork').folder['deepseek-flash']?.input, 110);
    assert.deepEqual(scopes('fork').all['deepseek-flash'], { input: 110, output: 0, cacheRead: 0, cacheWrite: 0, calls: 2 });
  });
});

describe('sessionUsageByProvider', () => {
  test("splits a session's calls by the provider each ran under, priced by its own prices", () => {
    const work: AttributedProvider = { id: 'work', type: 'compatible', models: ['glm-5.2'] };
    const usage: SessionUsage = {
      sessionId: 's',
      folder: undefined,
      calls: [
        { ...call('deepseek-flash', 100, { input: 1_000_000 }), id: 'a' },
        { ...call('deepseek-flash', 100, { input: 1_000_000 }), id: 'a' },
        { ...call('glm-5.2', 300, { output: 1_000_000 }), id: 'b' },
        { ...call('unknown-model', 400, { input: 5 }), id: 'c' },
      ],
    };
    const pricing: Record<string, ProviderPricing> = {
      deepseek: { currency: 'CNY', models: { 'deepseek-flash': { input: 2, output: 8 } } },
    };
    const result = sessionUsageByProvider(usage, [], [subscription, deepseek, work], (id) => pricing[id]);
    assert.deepEqual(Object.keys(result).sort(), ['deepseek', 'work']);
    assert.deepEqual(result.deepseek?.['deepseek-flash'], { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1, cost: 2 });
    // No prices: tokens only.
    assert.deepEqual(result.work?.['glm-5.2'], { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0, calls: 1 });
  });
});

describe('modelsUsed', () => {
  test('lists the models attributed to the provider, normalized, deduplicated and sorted', () => {
    const providers: AttributedProvider[] = [subscription, deepseek];
    const tagsBySession: Record<string, SessionTag[]> = {
      s1: [tag('deepseek', 0)],
      s2: [tag('subscription', 0)],
    };
    const sessions: SessionUsage[] = [
      { sessionId: 's1', folder: 'C:\\work', calls: [call('deepseek-flash', 100), call('DeepSeek-Flash', 200), call('deepseek-v4', 300)] },
      { sessionId: 's2', folder: 'C:\\work', calls: [call('claude-opus-5-5', 100)] },
    ];
    assert.deepEqual(
      modelsUsed(sessions, (id) => tagsBySession[id] ?? [], providers, 'deepseek'),
      ['deepseek-flash', 'deepseek-v4'],
    );
  });
});

describe('lastProvider', () => {
  test('takes the latest call, whatever order the calls come in', () => {
    const usage: SessionUsage = {
      sessionId: 's1',
      folder: undefined,
      calls: [call('deepseek-flash', 300), call('claude-opus-5-5', 200), call('deepseek-flash', 100)],
    };
    assert.equal(lastProvider(usage, [tag('deepseek', 0)], [subscription, deepseek]), 'deepseek');
  });

  test('with no calls it is the latest tag', () => {
    const usage: SessionUsage = { sessionId: 's1', folder: undefined, calls: [] };
    assert.equal(lastProvider(usage, [tag('deepseek', 100), tag('subscription', 200)], [subscription, deepseek]), 'subscription');
  });

  test('with no calls and no tags it is undefined', () => {
    assert.equal(lastProvider({ sessionId: 's1', folder: undefined, calls: [] }, [], [subscription]), undefined);
  });

  test('a session without usage still falls back to the tags', () => {
    assert.equal(lastProvider(undefined, [tag('deepseek', 100)], [subscription, deepseek]), 'deepseek');
  });
});

describe('addTokens', () => {
  test('accumulates the four token counts and the call count per model key', () => {
    const totals: Record<string, TokenCounts & { calls: number }> = {};
    addTokens(totals, call('DeepSeek-Flash', 1, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }));
    addTokens(totals, call('deepseek-flash', 2, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }));
    addTokens(totals, call('deepseek-v4', 3, { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }));
    assert.deepEqual(totals, {
      'deepseek-flash': { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, calls: 2 },
      'deepseek-v4': { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, calls: 1 },
    });
  });
});

describe('addTokens, unrecorded', () => {
  test("an unrecorded call's tokens count, and are told apart, but it is no call; its rule is not counted", () => {
    const totals: ModelTokens = {};
    addTokens(totals, call('deepseek-flash', 1, { input: 10 }), { cost: 1, rule: 'peak' });
    addTokens(totals, { ...call('deepseek-flash', 2, { input: 5, output: 7 }), unrecorded: true }, { cost: 2, rule: 'peak' });
    assert.deepEqual(totals['deepseek-flash'], {
      input: 15,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      calls: 1,
      cost: 3,
      rules: { peak: 1 },
      unrecorded: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 },
    });
  });
});

describe('unrecordedCalls', () => {
  const snapshot = (at: number, models: Record<string, Partial<TokenCounts>>): UsageSnapshot => ({
    at,
    models: Object.fromEntries(
      Object.entries(models).map(([model, tokens]) => [
        model,
        { input: tokens.input ?? 0, output: tokens.output ?? 0, cacheRead: tokens.cacheRead ?? 0, cacheWrite: tokens.cacheWrite ?? 0 },
      ]),
    ),
  });

  test('what the counts have beyond the calls up to their time, each part once, at their time', () => {
    const calls = [call('deepseek-flash', 100, { input: 100, output: 10 }), call('DeepSeek-Flash', 300, { input: 50, output: 5 })];
    const extra = unrecordedCalls(
      's1',
      [
        // A title (a call of its own) by the first turn's end.
        snapshot(200, { 'deepseek-flash': { input: 130, output: 20 } }),
        // Compacting, by the second's: the counts go on from the first.
        snapshot(400, { 'deepseek-flash': { input: 190, output: 1015, cacheRead: 5000 } }),
        // Nothing new: nothing more.
        snapshot(500, { 'deepseek-flash': { input: 190, output: 1015, cacheRead: 5000 } }),
      ],
      calls,
    );
    assert.deepEqual(extra, [
      {
        id: 's1:unrecorded:0:deepseek-flash',
        at: 200,
        model: 'deepseek-flash',
        input: 30,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        unrecorded: true,
      },
      {
        id: 's1:unrecorded:1:deepseek-flash',
        at: 400,
        model: 'deepseek-flash',
        input: 10,
        output: 990,
        cacheRead: 5000,
        cacheWrite: 0,
        unrecorded: true,
      },
    ]);
  });

  test('counts that have less than the transcripts (another process, a fork) add nothing, and take nothing back', () => {
    const calls = [call('m', 100, { input: 1000, output: 100 }), call('m', 300, { input: 1000, output: 100 })];
    const extra = unrecordedCalls(
      's1',
      [
        snapshot(200, { m: { input: 1100, output: 100 } }),
        // A process that counted only its own: less than the transcripts.
        snapshot(400, { m: { input: 500, output: 50 } }),
      ],
      calls,
    );
    assert.deepEqual(
      extra.map((one) => [one.input, one.output]),
      [[100, 0]],
    );
  });

  test('models apart; calls already unrecorded are not counted as recorded', () => {
    const calls = [call('a', 100, { input: 10 }), { ...call('b', 100, { input: 99 }), unrecorded: true }];
    const extra = unrecordedCalls('s1', [snapshot(200, { a: { input: 10 }, b: { input: 5 } })], calls);
    assert.deepEqual(
      extra.map((one) => [one.model, one.input]),
      [['b', 5]],
    );
  });
});

describe('unrecordedCalls, a gateway', () => {
  test('a model counted by the name asked for and recorded by the one answered with: only what is beyond in all', () => {
    const calls = [call('anthropic/claude-4.5-sonnet-20250929', 100, { input: 1000, output: 100 })];
    const extra = unrecordedCalls(
      's1',
      [{ at: 200, models: { 'anthropic/claude-sonnet-4.5': { input: 1200, output: 150, cacheRead: 0, cacheWrite: 0 } } }],
      calls,
    );
    assert.deepEqual(
      extra.map((one) => [one.model, one.input, one.output]),
      [['anthropic/claude-sonnet-4.5', 200, 50]],
    );
  });
});
