import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { contrast, ensureContrast, formatColor, luminance, parseColor, withAccent, type Rgba } from '../../../src/platform/accent';
import {
  CLAUDE_ACCENT,
  PRESET_ACCENTS,
  providerAccentColor,
  SUBSCRIPTION_PROVIDER,
  withoutLegacyColor,
  type ProviderConfig,
} from '../../../src/platform/providers';
import type { ThemeData } from '../../../src/platform/protocol';
import { PROVIDER_PRESETS } from '../../../src/features/providers/presets';
import darkModern from '../../../resources/themes/dark-modern.json';
import lightModern from '../../../resources/themes/light-modern.json';
import hcDark from '../../../resources/themes/hc-dark.json';

const color = (value: string | undefined): Rgba => {
  const parsed = parseColor(value);
  assert.ok(parsed, `not a color: ${value}`);
  return parsed;
};
const dark = darkModern as ThemeData;
const light = lightModern as ThemeData;
const v = (theme: ThemeData, key: string): string | undefined => theme.variables[`vscode-${key}`];

describe('colors', () => {
  test('parses and formats the forms themes use', () => {
    assert.deepEqual(parseColor('#0078D4'), { r: 0, g: 120, b: 212, a: 1 });
    assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
    assert.equal(formatColor(color('rgba(36, 137, 219, 0.51)')), 'rgba(36, 137, 219, 0.51)');
    assert.equal(formatColor(color('#00000080')), 'rgba(0, 0, 0, 0.502)');
    assert.equal(parseColor('transparent'), undefined);
    assert.equal(parseColor('var(--x)'), undefined);
  });

  test("contrast is WCAG's, and ensureContrast moves a color only as far as it must", () => {
    assert.equal(contrast(color('#ffffff'), color('#000000')), 21);
    const editor = color('#1f1f1f');
    assert.equal(formatColor(ensureContrast(color('#d97757'), editor, 3)), '#d97757');
    const black = ensureContrast(color('#000000'), editor, 3);
    assert.ok(contrast(black, editor) >= 3 && contrast(black, editor) < 3.05, formatColor(black));
    // On white it darkens instead.
    const lightBlue = ensureContrast(color('#8ab4f8'), color('#ffffff'), 3);
    assert.ok(luminance(lightBlue) < luminance(color('#8ab4f8')));
  });
});

describe('withAccent', () => {
  test('no accent: the theme as it is, and no line', () => {
    const themed = withAccent(dark, undefined);
    assert.equal(themed.variables['vilaus-accent'], 'transparent');
    assert.equal(v(themed, 'focusBorder'), v(dark, 'focusBorder'));
  });

  test("Dark Modern in Claude's orange: lines, fills, selections and highlights; neutral colors stay", () => {
    const themed = withAccent(dark, CLAUDE_ACCENT);
    const editor = color(v(dark, 'editor-background'));
    assert.equal(themed.variables['vilaus-accent'], CLAUDE_ACCENT);
    assert.equal(v(themed, 'focusBorder'), CLAUDE_ACCENT);
    assert.equal(v(themed, 'tab-activeBorderTop'), CLAUDE_ACCENT);
    assert.equal(v(themed, 'inputOption-activeBorder'), CLAUDE_ACCENT);
    // The primary button: visible on the background, white text readable on it.
    const button = color(v(themed, 'button-background'));
    assert.equal(v(themed, 'button-foreground'), '#ffffff');
    assert.ok(contrast(button, color('#ffffff')) >= 4.5);
    assert.ok(contrast(button, editor) >= 3);
    assert.notEqual(v(themed, 'button-hoverBackground'), v(themed, 'button-background'));
    // The selection: a dark orange, about as strong as the theme's dark blue was.
    const selection = color(v(themed, 'list-activeSelectionBackground'));
    assert.ok(selection.r > selection.b && luminance(selection) < 0.1, formatColor(selection));
    assert.ok(contrast(color(v(themed, 'list-activeSelectionForeground')), selection) >= 4.5);
    assert.ok(contrast(color(v(themed, 'list-highlightForeground')), editor) >= 4.5);
    // Not the accent's: badges are grey in Dark Modern; links stay links.
    assert.equal(v(themed, 'badge-background'), v(dark, 'badge-background'));
    assert.equal(v(themed, 'textLink-foreground'), v(dark, 'textLink-foreground'));
    assert.equal(v(themed, 'editor-background'), v(dark, 'editor-background'));
  });

  test('a black accent is lifted until it shows on a dark theme', () => {
    const themed = withAccent(dark, '#000000');
    const editor = color(v(dark, 'editor-background'));
    assert.ok(contrast(color(v(themed, 'focusBorder')), editor) >= 3);
    assert.ok(contrast(color(themed.variables['vilaus-accent']), color(v(dark, 'titleBar-activeBackground'))) >= 3);
    const button = color(v(themed, 'button-background'));
    assert.ok(contrast(button, editor) >= 3);
    assert.ok(contrast(color(v(themed, 'button-foreground')), button) >= 4.5);
  });

  test('Light Modern: a light accent darkens; its grey selections stay grey', () => {
    const themed = withAccent(light, '#8ab4f8');
    assert.ok(contrast(color(v(themed, 'focusBorder')), color('#ffffff')) >= 3);
    assert.equal(v(themed, 'list-activeSelectionBackground'), v(light, 'list-activeSelectionBackground'));
    assert.notEqual(v(themed, 'inputOption-activeBackground'), v(light, 'inputOption-activeBackground'));
  });

  test('high contrast themes keep their colors; only the line takes the accent', () => {
    const themed = withAccent(hcDark as ThemeData, '#4d6bfe');
    assert.equal(themed.variables['vilaus-accent'], '#4d6bfe');
    assert.equal(v(themed, 'focusBorder'), v(hcDark as ThemeData, 'focusBorder'));
  });

  test('the setting: only the line, or nothing', () => {
    const line = withAccent(dark, '#4d6bfe', 'line');
    assert.equal(line.variables['vilaus-accent'], '#4d6bfe');
    assert.equal(v(line, 'focusBorder'), v(dark, 'focusBorder'));
    const off = withAccent(dark, '#4d6bfe', 'off');
    assert.equal(off.variables['vilaus-accent'], 'transparent');
    assert.equal(v(off, 'button-background'), v(dark, 'button-background'));
  });
});

describe('provider accents', () => {
  const compatible = (fields: Partial<ProviderConfig>): ProviderConfig => ({ id: 'p', name: 'P', type: 'compatible', ...fields });

  test("a pick, else the vendor's, else Claude's for Claude's APIs; nothing for an unknown API", () => {
    assert.equal(providerAccentColor(SUBSCRIPTION_PROVIDER), CLAUDE_ACCENT);
    assert.equal(providerAccentColor(compatible({ preset: 'deepseek' })), PRESET_ACCENTS.deepseek);
    assert.equal(providerAccentColor(compatible({ preset: 'deepseek', color: '#123456' })), '#123456');
    assert.equal(providerAccentColor(compatible({ preset: 'custom' })), undefined);
    assert.equal(providerAccentColor(compatible({})), undefined);
    assert.equal(providerAccentColor({ id: 'b', name: 'B', type: 'bedrock' }), CLAUDE_ACCENT);
  });

  test("colors earlier versions stored without a pick are dropped; picked ones stay", () => {
    assert.equal(withoutLegacyColor(compatible({ preset: 'kimi', color: '#0ea5a4' })).color, undefined);
    assert.equal(withoutLegacyColor(compatible({ preset: 'kimi', color: '#123456' })).color, '#123456');
    assert.equal(withoutLegacyColor(compatible({ color: '#8a8a8a' })).color, undefined);
    assert.equal(withoutLegacyColor(compatible({ preset: 'qwen' })).color, undefined);
  });

  test('every preset but the custom one has an accent, and every accent a preset', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    assert.deepEqual(
      ids.filter((id) => id !== 'custom' && !PRESET_ACCENTS[id]),
      [],
    );
    assert.deepEqual(Object.keys(PRESET_ACCENTS).filter((id) => !ids.includes(id)), []);
    for (const preset of PROVIDER_PRESETS) {
      assert.equal(preset.config.color, undefined, `${preset.id} stores a color`);
    }
  });
});
