import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { modelKey, pricingJson, readPricingAnswer } from '../../../src/platform/pricing';
import { presetById, presetPricing, PROVIDER_PRESETS } from '../../../src/features/providers/presets';
import PRESET_PRICES from '../../../src/features/providers/presetPrices.json';

describe('the prices the presets ship', () => {
  const shipped = Object.entries(PRESET_PRICES as Record<string, unknown>);

  test('belong to presets billed per token, in their currency', () => {
    for (const [id, value] of shipped) {
      const preset = presetById(id);
      assert.ok(preset?.prices, `${id}: no preset with a price list`);
      assert.equal((value as { currency?: string }).currency, preset.currency, id);
    }
  });

  test('read as a pasted answer is read: no problem at all', () => {
    for (const [id, value] of shipped) {
      const { answer, problems } = readPricingAnswer(JSON.stringify(value));
      assert.deepEqual(problems, [], id);
      // Nothing the lenient reading of the app drops.
      assert.equal(
        pricingJson(presetPricing(id) ?? { currency: 'USD', models: {} }),
        pricingJson(answer?.pricing ?? { currency: 'USD', models: {} }),
        id,
      );
    }
  });

  test('say where and when they were read', () => {
    for (const [id] of shipped) {
      const sources = presetPricing(id)?.sources ?? [];
      assert.ok(
        sources.some((source) => source.url === presetById(id)?.prices && /^\d{4}-\d{2}-\d{2}$/.test(source.checked ?? '')),
        `${id}: ${JSON.stringify(sources)}`,
      );
    }
  });

  test('a preset with none has none', () => {
    const without = PROVIDER_PRESETS.find((preset) => !(preset.id in (PRESET_PRICES as Record<string, unknown>)));
    assert.ok(without);
    assert.equal(presetPricing(without.id), undefined);
    assert.equal(presetPricing(undefined), undefined);
  });

  test("price the preset's own main model", () => {
    for (const [id] of shipped) {
      const main = presetById(id)?.config.models?.main ?? presetById(id)?.config.models?.opus;
      if (main) assert.ok(presetPricing(id)?.models[modelKey(main)], `${id}: no price for ${main}`);
    }
  });
});
