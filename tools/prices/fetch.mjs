// Step 1 of the default prices (docs/ARCHITECTURE.md, "用量和费用"): each priced preset's price
// page, rendered in Edge and saved as text, with the request to read its prices from that text
// (the app's own prompt, told to read the file instead of browsing).
//
//   node tools/prices/fetch.mjs [preset ...]     -> .local/prices/<date>/<preset>.txt, <preset>.task.md
//   node tools/prices/fetch.mjs --tasks [...]    the tasks again from today's texts (when a site is down)
//
// Then: an AI that reads files answers each task; its answer saved as <preset>.json; tools/prices/check.mjs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { chromium } from 'playwright-core';
import { loadLib, MORE_PAGES, PRICED_PRESETS, root, today } from './bundle.mjs';

const lib = await loadLib();
const date = today();
const outDir = path.join(root, '.local', 'prices', date);
mkdirSync(outDir, { recursive: true });
const tasksOnly = process.argv.includes('--tasks');
const wanted = process.argv.slice(2).filter((arg) => arg !== '--tasks');
const presets = lib.PROVIDER_PRESETS.filter(
  (preset) => PRICED_PRESETS.includes(preset.id) && (wanted.length === 0 || wanted.includes(preset.id)),
);

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const preset of presets) {
    const page = await browser.newPage({ locale: preset.currency === 'CNY' ? 'zh-CN' : 'en-US' });
    const read = async (url) => {
      // Big pages (Alibaba Cloud's) sometimes take longer than a minute: a second try.
      await page
        .goto(url, { waitUntil: 'load', timeout: 60_000 })
        .catch(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 }));
      // Pages that keep talking (analytics) never go idle: a while is enough for the tables.
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(3000);
      return `${url}\n\n${await page.evaluate(() => document.body.innerText)}`;
    };
    try {
      const more = MORE_PAGES[preset.id] ?? [];
      const file = path.join(outDir, `${preset.id}.txt`);
      let text;
      if (tasksOnly) {
        text = readFileSync(file, 'utf8');
      } else {
        const texts = [await read(preset.prices)];
        for (const url of more) texts.push(await read(url));
        text = texts.join('\n\n==========\n\n');
        writeFileSync(file, text, 'utf8');
      }
      const models = [...new Set(Object.values(preset.config.models ?? {}).map(lib.modelKey))].filter(Boolean);
      const prompt = lib.pricingPrompt({
        provider: preset.name(),
        baseUrl: preset.config.baseUrl,
        pricesUrl: preset.prices,
        currency: preset.currency ?? 'USD',
        models,
        language: 'Simplified Chinese',
        today: date,
      });
      const task = [
        `The price page has been downloaded for you on ${date}: ${file}`,
        ...(more.length > 0
          ? [`After the price page, the file holds more of the provider's own pages the prices need: ${more.join(', ')}.`]
          : []),
        'Read that file as the price page; do not browse (you need not, CANNOT_BROWSE does not apply). Take every price from it, and quote it in "evidence" exactly as it is written there (the checker looks each quote up in the file).',
        `Answer with the JSON alone: no code block, nothing before or after it (it is saved as ${preset.id}.json).`,
        '',
        '---',
        '',
        prompt,
      ].join('\n');
      writeFileSync(path.join(outDir, `${preset.id}.task.md`), task, 'utf8');
      console.log(`${preset.id}: ${text.length} characters from ${[preset.prices, ...more].join(', ')}`);
    } catch (error) {
      console.log(`${preset.id}: FAILED ${error?.message ?? error}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`-> ${outDir}`);
