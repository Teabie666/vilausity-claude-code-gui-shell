import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  costAt,
  pricingJson,
  pricingPrompt,
  readPricing,
  readPricingAnswer,
  ruleFor,
  ruleHolds,
  type PricedCall,
  type PriceWhen,
  type ProviderPricing,
} from '../../../src/platform/pricing';
import { summarizeUsage, type UsageCall } from '../../../src/platform/usage';

// 2026-01-05 is a Monday; Beijing time is UTC+8 all year.
const at = (iso: string): number => Date.parse(iso);
const call = (iso: string, tokens: Partial<PricedCall> = {}): PricedCall => ({
  at: at(iso),
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...tokens,
});
const holds = (when: PriceWhen, iso: string, tokens: Partial<PricedCall> = {}): boolean => ruleHolds(when, call(iso, tokens));

const ANSWER = {
  vilausPricing: 1,
  currency: 'CNY',
  models: {
    'DeepSeek-Chat': {
      input: 2,
      cacheRead: 0.2,
      output: 8,
      rules: [{ label: '空闲', when: { zone: 'Asia/Shanghai', from: '00:30', to: '08:30' }, input: 1, cacheRead: 0.1, output: 4 }],
    },
  },
  sources: [{ url: 'https://api-docs.deepseek.com/quick_start/pricing', checked: '2026-10-13' }],
  evidence: { 'deepseek-chat': '输入 2 元' },
  missing: { 'deepseek-old': '不在价格页上' },
  notes: ['节假日不清楚'],
};

describe('readPricingAnswer', () => {
  test('reads the JSON of an answer, in a code block with words around it', () => {
    const text = `Here are the prices:\n\`\`\`json\n${JSON.stringify(ANSWER, null, 2)}\n\`\`\`\nHope this helps.`;
    const { answer, problems } = readPricingAnswer(text);
    assert.deepEqual(problems, []);
    assert.ok(answer);
    assert.equal(answer.pricing.currency, 'CNY');
    // Model names as modelKey writes them.
    assert.deepEqual(Object.keys(answer.pricing.models), ['deepseek-chat']);
    assert.equal(answer.pricing.models['deepseek-chat']?.rules?.[0]?.label, '空闲');
    assert.deepEqual(answer.pricing.sources, ANSWER.sources);
    assert.deepEqual(answer.pricing.notes, ANSWER.notes);
    assert.deepEqual(answer.missing, { 'deepseek-old': '不在价格页上' });
    assert.deepEqual(answer.evidence, { 'deepseek-chat': '输入 2 元' });
  });

  test('an AI that cannot browse, no JSON, broken JSON', () => {
    assert.equal(readPricingAnswer('CANNOT_BROWSE').problems[0]?.code, 'cannotBrowse');
    assert.equal(readPricingAnswer('no idea').problems[0]?.code, 'noJson');
    assert.equal(readPricingAnswer('{"currency": "CNY",}').problems[0]?.code, 'badJson');
  });

  test('tells every problem, with where it is, and takes nothing then', () => {
    const { answer, problems } = readPricingAnswer(
      JSON.stringify({
        currency: 'RMB',
        models: {
          a: { input: 1, output: -1, cache_read: 0.1 },
          b: {
            input: 1,
            output: 2,
            rules: [
              { label: 'x', when: { from: '9:00', to: '18:00', days: [0, 1] }, input: 1, output: 1 },
              { label: 'y', when: { inputOver: 128000, inputUpTo: 32000 }, input: 1, output: 1 },
              { when: {}, input: 1, output: 1 },
            ],
          },
        },
      }),
    );
    assert.equal(answer, undefined);
    const told = problems.map((problem) => `${problem.path} ${problem.code}${problem.detail ? ` ${problem.detail}` : ''}`);
    assert.deepEqual(
      told.sort(),
      [
        'currency badCurrency "RMB"',
        'models["a"] unknownKey cache_read',
        'models["a"].output notNumber -1',
        'models["b"].rules[0].when.days badDays [0,1]',
        'models["b"].rules[0].when zoneNeeded',
        'models["b"].rules[0].when.from badTime 9:00',
        'models["b"].rules[1].when badRange inputOver 128000 >= inputUpTo 32000',
        'models["b"].rules[2].label missing',
        'models["b"].rules[2].when emptyWhen',
      ].sort(),
    );
  });

  test('a time zone that does not exist, a date that does not, a time without its pair', () => {
    const { problems } = readPricingAnswer(
      JSON.stringify({
        currency: 'USD',
        models: {
          a: {
            input: 1,
            output: 2,
            rules: [{ label: 'x', when: { zone: 'Mars/Olympus', from: '09:00', startDate: '2026-02-30' }, input: 1, output: 1 }],
          },
        },
      }),
    );
    const codes = problems.map((problem) => problem.code).sort();
    assert.deepEqual(codes, ['badDate', 'badZone', 'timePair']);
  });

  test('holidays it knows, with a time zone', () => {
    const answer = (when: Record<string, unknown>): string[] =>
      readPricingAnswer(
        JSON.stringify({ currency: 'CNY', models: { a: { input: 1, output: 2, rules: [{ label: 'x', when, input: 2, output: 4 }] } } }),
      ).problems.map((problem) => problem.code);
    assert.deepEqual(answer({ zone: 'Asia/Shanghai', from: '09:00', to: '12:00', exceptHolidays: 'CN' }), []);
    assert.deepEqual(answer({ zone: 'Asia/Shanghai', exceptHolidays: 'US' }), ['badHolidays']);
    assert.deepEqual(answer({ from: '09:00', to: '12:00', exceptHolidays: 'CN' }), ['zoneNeeded']);
    const read = readPricingAnswer(
      JSON.stringify({
        currency: 'CNY',
        models: {
          a: { input: 1, output: 2, rules: [{ label: 'x', when: { zone: 'Asia/Shanghai', exceptHolidays: 'CN' }, input: 2, output: 4 }] },
        },
      }),
    );
    assert.equal(read.answer?.pricing.models.a?.rules?.[0]?.when.exceptHolidays, 'CN');
  });

  test('needs a model with prices', () => {
    assert.equal(readPricingAnswer('{"currency": "USD", "models": {}}').problems[0]?.code, 'noModels');
  });

  test('what Copy Prices writes reads back the same', () => {
    const pricing = readPricingAnswer(JSON.stringify(ANSWER)).answer?.pricing;
    assert.ok(pricing);
    assert.deepEqual(readPricingAnswer(pricingJson(pricing)).answer?.pricing, pricing);
  });
});

describe('readPricing, leniently (providers.json)', () => {
  test('a rule with problems is left out, its model kept; a model with bad prices goes', () => {
    const { answer } = readPricing(
      {
        currency: 'CNY',
        models: {
          kept: { input: 1, output: 2, rules: [{ label: 'bad', when: { from: '25:00', to: '01:00', zone: 'UTC' }, input: 1, output: 1 }] },
          gone: { input: 'one', output: 2 },
        },
      },
      false,
    );
    assert.deepEqual(answer?.pricing, { currency: 'CNY', models: { kept: { input: 1, output: 2 } } });
  });
});

describe('ruleHolds', () => {
  const offPeak: PriceWhen = { zone: 'Asia/Shanghai', from: '22:00', to: '08:00' };

  test('a window past midnight, in its time zone', () => {
    assert.equal(holds(offPeak, '2026-01-05T15:00:00Z'), true); // 23:00 there
    assert.equal(holds(offPeak, '2026-01-05T23:30:00Z'), true); // 07:30 the next day
    assert.equal(holds(offPeak, '2026-01-06T00:00:00Z'), false); // 08:00: "to" is not included
    assert.equal(holds(offPeak, '2026-01-05T14:00:00Z'), true); // 22:00: "from" is
    assert.equal(holds(offPeak, '2026-01-05T01:00:00Z'), false); // 09:00
  });

  test('the local day, not the UTC one', () => {
    const weekdays: PriceWhen = { zone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
    assert.equal(holds(weekdays, '2026-01-05T02:00:00Z'), true); // Monday 10:00
    assert.equal(holds(weekdays, '2026-01-10T02:00:00Z'), false); // Saturday 10:00
    const weekend: PriceWhen = { zone: 'Asia/Shanghai', days: [6, 7] };
    assert.equal(holds(weekend, '2026-01-09T16:30:00Z'), true); // Friday in UTC, Saturday 00:30 there
    assert.equal(holds(weekend, '2026-01-11T16:30:00Z'), false); // Monday 00:30 there
  });

  test('dates, both included, in the time zone', () => {
    const offer: PriceWhen = { zone: 'Asia/Shanghai', startDate: '2026-01-05', endDate: '2026-01-06' };
    assert.equal(holds(offer, '2026-01-04T16:00:00Z'), true); // January 5, 00:00 there
    assert.equal(holds(offer, '2026-01-06T15:59:00Z'), true); // January 6, 23:59
    assert.equal(holds(offer, '2026-01-06T16:00:00Z'), false); // January 7
    assert.equal(holds(offer, '2026-01-04T15:59:00Z'), false); // January 4
  });

  test("the input's length counts the cache, over the lower end and up to the upper", () => {
    const tier: PriceWhen = { inputOver: 32000, inputUpTo: 128000 };
    assert.equal(holds(tier, '2026-01-05T00:00:00Z', { input: 1000, cacheRead: 31000 }), false);
    assert.equal(holds(tier, '2026-01-05T00:00:00Z', { input: 1000, cacheRead: 31000, cacheWrite: 1 }), true);
    assert.equal(holds(tier, '2026-01-05T00:00:00Z', { input: 128000 }), true);
    assert.equal(holds(tier, '2026-01-05T00:00:00Z', { input: 128001 }), false);
    assert.equal(holds({ outputUpTo: 200 }, '2026-01-05T00:00:00Z', { input: 5, output: 201 }), false);
  });

  test('thinking', () => {
    assert.equal(holds({ thinking: true }, '2026-01-05T00:00:00Z'), false);
    assert.equal(holds({ thinking: true }, '2026-01-05T00:00:00Z', { thinking: true }), true);
    assert.equal(holds({ thinking: false }, '2026-01-05T00:00:00Z'), true);
  });

  test("not on mainland China's public holidays, by the date in its time zone", () => {
    const peak: PriceWhen = { zone: 'Asia/Shanghai', days: [1, 2, 3, 4, 5], from: '09:00', to: '12:00', exceptHolidays: 'CN' };
    assert.equal(holds(peak, '2026-10-06T02:00:00Z'), false); // Tuesday 10:00, National Day holidays
    assert.equal(holds(peak, '2026-10-13T02:00:00Z'), true); // Tuesday 10:00, a working day
    assert.equal(holds(peak, '2026-10-07T03:59:00Z'), false); // Wednesday 11:59, the last day off
    assert.equal(holds(peak, '2026-10-08T01:00:00Z'), true); // Thursday 09:00: back at work
    // Without the condition the holidays are days like any other.
    assert.equal(holds({ ...peak, exceptHolidays: undefined }, '2026-10-06T02:00:00Z'), true);
    // A year it knows no holidays of: every day holds.
    assert.equal(holds(peak, '2027-10-05T02:00:00Z'), true);
  });
});

describe('pricing a call', () => {
  const price = {
    input: 4,
    output: 16,
    rules: [
      { label: 'long', when: { inputOver: 100 }, input: 8, output: 32 },
      { label: 'longer', when: { inputOver: 1000 }, input: 99, output: 99 },
    ],
  };

  test('the first rule that holds prices the whole call; with none, the model does', () => {
    const long = call('2026-01-05T00:00:00Z', { input: 2000, output: 1000 });
    assert.equal(ruleFor(price, long)?.label, 'long');
    assert.equal(costAt(long, ruleFor(price, long) ?? price), (2000 * 8 + 1000 * 32) / 1e6);
    assert.equal(ruleFor(price, call('2026-01-05T00:00:00Z', { input: 50 })), undefined);
  });

  test('summarizeUsage adds up what each call cost and counts the calls of each rule', () => {
    const pricing: ProviderPricing = { currency: 'USD', models: { 'model-a': price } };
    const calls: UsageCall[] = [
      { model: 'model-a', at: 1, input: 50, output: 0, cacheRead: 0, cacheWrite: 0 },
      { model: 'Model-A[1m]', at: 2, input: 2000, output: 0, cacheRead: 0, cacheWrite: 0 },
      { model: 'model-b', at: 3, input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
    ];
    const provider = { id: 'p', type: 'compatible' as const, models: ['model-a', 'model-b'] };
    const { all } = summarizeUsage([{ sessionId: 's', folder: undefined, calls }], () => [], [provider], { provider: 'p', pricing });
    assert.ok(Math.abs((all['model-a']?.cost ?? 0) - (50 * 4 + 2000 * 8) / 1e6) < 1e-12);
    assert.deepEqual(all['model-a']?.rules, { long: 1 });
    assert.equal(all['model-a']?.calls, 2);
    // No price: no cost, not 0.
    assert.equal(all['model-b']?.cost, undefined);
  });
});

describe('pricingPrompt', () => {
  const prompt = pricingPrompt({
    provider: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    pricesUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    currency: 'CNY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    language: 'Simplified Chinese',
    today: '2026-10-13',
  });

  test('names the provider, its page, its models, the language and the day', () => {
    for (const part of [
      'DeepSeek',
      'https://api.deepseek.com/anthropic',
      'https://api-docs.deepseek.com/quick_start/pricing',
      'deepseek-chat, deepseek-reasoner',
      'Simplified Chinese',
      'Today: 2026-10-13',
      'CANNOT_BROWSE',
    ]) {
      assert.ok(prompt.includes(part), part);
    }
  });

  test('its example is an answer the editor takes', () => {
    const example = /```json\n([\s\S]*?)\n```/.exec(prompt)?.[1];
    assert.ok(example);
    assert.deepEqual(readPricingAnswer(example).problems, []);
  });
});
