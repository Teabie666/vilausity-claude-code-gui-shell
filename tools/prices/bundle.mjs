// The app's presets and price reading, for the price tools: lib.ts bundled into .test-build.
import { build } from 'esbuild';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
export const root = path.resolve(here, '..', '..');

/**
 * The presets billed per token that ship default prices: the mainland China sites only (the
 * international ones price the same models far apart, and are not what their users pay); the
 * coding plans are flat fees, OpenRouter has too many models. A site that cannot be reached is
 * left without defaults.
 */
export const PRICED_PRESETS = ['deepseek', 'kimi', 'glm', 'qwen'];

/** More of a provider's own pages the prices need: Alibaba Cloud prices its cache hits on another page. */
export const MORE_PAGES = { qwen: ['https://help.aliyun.com/zh/model-studio/context-cache'] };

/** Where the default prices live in the app. */
export const PRESET_PRICES = path.join(root, 'src', 'features', 'providers', 'presetPrices.json');

export async function loadLib() {
  const outfile = path.join(root, '.test-build', 'prices-lib.mjs');
  await build({
    entryPoints: [path.join(here, 'lib.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    mainFields: ['module', 'main'],
    logLevel: 'error',
  });
  return import(`${pathToFileURL(outfile).href}?${Date.now()}`);
}

/** The local date, YYYY-MM-DD. */
export function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
