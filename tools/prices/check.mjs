// Step 2 of the default prices: checks each answer (<preset>.json, next to the page text that
// tools/prices/fetch.mjs saved) and, with --write, puts the good ones into the app
// (src/features/providers/presetPrices.json), telling what changed since the last time.
//
//   node tools/prices/check.mjs [YYYY-MM-DD] [--write]
//
// Checked: the format, as the providers editor reads a paste; the currency; that every model of
// the preset is priced or said missing; that every quote in "evidence" is in the page as it is
// written; that every price shows in the page (a number written nowhere there is made up, or
// converted: those are listed for a look).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { loadLib, PRESET_PRICES, PRICED_PRESETS, root, today } from './bundle.mjs';

const lib = await loadLib();
const write = process.argv.includes('--write');
const date = process.argv.slice(2).find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ?? today();
const dir = path.join(root, '.local', 'prices', date);
const flat = (text) => text.replace(/\s+/g, ' ').trim();

/** The ways a page may write a price: 9, 9.0, 9.00, 0.3 as 0.30. */
function spellings(value) {
  return [...new Set([String(value), value.toFixed(1), value.toFixed(2), value.toFixed(3), value.toFixed(4)])];
}

function shown(page, value) {
  return spellings(value).some((spelling) => new RegExp(`(?<![\\d.])${spelling.replace('.', '\\.')}(?![\\d])`).test(page));
}

const previous = existsSync(PRESET_PRICES) ? JSON.parse(readFileSync(PRESET_PRICES, 'utf8')) : {};
const next = { ...previous };
let bad = 0;
for (const preset of lib.PROVIDER_PRESETS.filter((candidate) => PRICED_PRESETS.includes(candidate.id))) {
  const answerFile = path.join(dir, `${preset.id}.json`);
  const pageFile = path.join(dir, `${preset.id}.txt`);
  if (!existsSync(answerFile) || !existsSync(pageFile)) {
    console.log(`\n== ${preset.id}: no answer or page in ${dir}, kept as it was`);
    continue;
  }
  const page = flat(readFileSync(pageFile, 'utf8'));
  const { answer, problems } = lib.readPricingAnswer(readFileSync(answerFile, 'utf8'));
  const issues = problems.map((problem) => `format: ${problem.path} ${problem.code} ${problem.detail ?? ''}`);
  const warnings = [];
  if (answer) {
    const { pricing } = answer;
    if (pricing.currency !== preset.currency) issues.push(`currency ${pricing.currency}, the preset bills in ${preset.currency}`);
    const models = [...new Set(Object.values(preset.config.models ?? {}).map(lib.modelKey))].filter(Boolean);
    for (const model of models) {
      if (!pricing.models[model] && !answer.missing[model]) issues.push(`${model}: neither priced nor missing`);
    }
    for (const [model, price] of Object.entries(pricing.models)) {
      const quote = answer.evidence[model];
      if (!quote) issues.push(`${model}: no evidence`);
      else if (!page.includes(flat(quote))) issues.push(`${model}: evidence not in the page: ${quote}`);
      for (const [where, prices] of [['', price], ...(price.rules ?? []).map((rule) => [` rule "${rule.label}"`, rule])]) {
        for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
          const value = prices[field];
          if (value !== undefined && !shown(page, value)) warnings.push(`${model}${where} ${field} ${value}: not written so in the page`);
        }
      }
    }
    if (!pricing.sources?.some((source) => source.url === preset.prices)) warnings.push(`sources do not name ${preset.prices}`);
  }
  console.log(`\n== ${preset.id} (${preset.currency}): ${issues.length === 0 ? 'OK' : `${issues.length} problem(s)`}`);
  for (const issue of issues) console.log(`  !! ${issue}`);
  for (const warning of warnings) console.log(`  ?  ${warning}`);
  if (!answer) {
    bad++;
    continue;
  }
  // What it says, to read against the page.
  for (const [model, price] of Object.entries(answer.pricing.models)) {
    const prices = (p) => `in ${p.input} / hit ${p.cacheRead ?? '-'} / write ${p.cacheWrite ?? '-'} / out ${p.output}`;
    console.log(`  ${model}: ${prices(price)}`);
    for (const rule of price.rules ?? []) console.log(`    ${rule.label}: ${JSON.stringify(rule.when)} -> ${prices(rule)}`);
  }
  for (const [model, reason] of Object.entries(answer.missing)) console.log(`  missing ${model}: ${reason}`);
  for (const note of answer.pricing.notes ?? []) console.log(`  note: ${note}`);
  if (issues.length > 0) {
    bad++;
    continue;
  }
  const before = JSON.stringify(previous[preset.id] ?? null);
  next[preset.id] = answer.pricing;
  if (before !== JSON.stringify(answer.pricing)) {
    console.log(before === 'null' ? '  (new)' : `  (changed; was ${before})`);
  }
}

if (write) {
  if (bad > 0) {
    console.log(`\n${bad} preset(s) with problems: nothing written.`);
    process.exit(1);
  }
  const sorted = Object.fromEntries(
    Object.keys(next)
      .sort()
      .map((id) => [id, next[id]]),
  );
  writeFileSync(PRESET_PRICES, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  console.log(`\n-> ${path.relative(root, PRESET_PRICES)}`);
}
