/**
 * A window's accent color laid over the theme: its API provider's (`providerAccentColor` in
 * providers.ts), one the user picked, or none (VS Code's own); the `vilaus.accent` setting. VS Code's themes draw focus outlines, the active tab's line, primary
 * buttons, selections and match highlights in one accent (Dark Modern's #0078d4). Of the keys
 * listed below, those whose theme value is in the theme's own accent hue take the window's
 * accent instead, the way the theme used its own:
 * - lines and outlines at 3:1 against the background at least (WCAG's minimum for UI parts);
 * - filled controls (primary buttons, the menu's selection, badges) at 3:1 against the
 *   background, darkened when needed so that their white text has 4.5:1;
 * - selections and tints as strong over their background as the theme's own were;
 * - highlighted text (matches in lists) at 4.5:1.
 * A theme value outside the accent's hue (Light Modern's grey selections) stays as it is;
 * high contrast themes keep all their colors. Every theme gets `--vilaus-accent`: the line
 * at the top of the window (transparent without an accent), the `--vilaus-accent-line /
 * -fill / -fill-foreground` the extension's pages take for their own orange (bridge.ts;
 * `initial`, so that the page keeps its own, when the theme keeps its colors), and
 * `--vilaus-logo`, the title bar's logo (`logoColor`) as visible on it as the line.
 * Pure functions: main computes each window's theme with them; the tests use them directly.
 */

import { LOGO_COLOR } from './logoMark';
import type { ThemeData } from './protocol';
import { CLAUDE_ACCENT } from './providers';

/** Where a window's accent comes from: its API provider, the user's color, or nowhere (VS Code's). */
export type AccentSource = 'provider' | 'custom' | 'vscode';

export const ACCENT_SOURCES: readonly AccentSource[] = ['provider', 'custom', 'vscode'];
export const ACCENT_SETTING = 'vilaus.accent';
/** The color of `custom`. */
export const ACCENT_COLOR_SETTING = 'vilaus.accent.custom';
export const DEFAULT_CUSTOM_ACCENT = '#d97757';

/** The variables the extension's pages read: unset (`initial`) leaves them their own colors. */
const PAGE_ACCENT_UNSET = {
  'vilaus-accent-line': 'initial',
  'vilaus-accent-fill': 'initial',
  'vilaus-accent-fill-foreground': 'initial',
};

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)` and `rgba(...)`; anything else is undefined. */
export function parseColor(value: string | undefined): Rgba | undefined {
  const text = value?.trim().toLowerCase();
  if (!text) {
    return undefined;
  }
  let match = /^#([0-9a-f]{3})$/.exec(text);
  if (match) {
    const [r, g, b] = match[1]!.split('').map((digit) => parseInt(digit + digit, 16));
    return { r: r!, g: g!, b: b!, a: 1 };
  }
  match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(text);
  if (match) {
    const hex = match[1]!;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: match[2] ? parseInt(match[2], 16) / 255 : 1,
    };
  }
  match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
  if (match) {
    const channel = (part: string): number => Math.max(0, Math.min(255, Number(part)));
    return { r: channel(match[1]!), g: channel(match[2]!), b: channel(match[3]!), a: match[4] ? Math.max(0, Math.min(1, Number(match[4]))) : 1 };
  }
  return undefined;
}

export function formatColor(color: Rgba): string {
  const hex = (channel: number): string => Math.round(channel).toString(16).padStart(2, '0');
  return color.a >= 1 ? `#${hex(color.r)}${hex(color.g)}${hex(color.b)}` : `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${Number(color.a.toFixed(3))})`;
}

/** WCAG relative luminance. */
export function luminance(color: Rgba): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** `t` of `a` and the rest of `b`, opaque. */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return { r: a.r * t + b.r * (1 - t), g: a.g * t + b.g * (1 - t), b: a.b * t + b.b * (1 - t), a: 1 };
}

/** A translucent color as it shows over `background`. */
function over(color: Rgba, background: Rgba): Rgba {
  return color.a >= 1 ? color : mix(color, background, color.a);
}

/**
 * The color, moved toward white or black (whichever contrasts more with `against`) just far
 * enough to reach `ratio` against it; the color itself when it already does.
 */
export function ensureContrast(color: Rgba, against: Rgba, ratio: number): Rgba {
  const opaque = { ...color, a: 1 };
  if (contrast(opaque, against) >= ratio) {
    return opaque;
  }
  const target = contrast(WHITE, against) >= contrast(BLACK, against) ? WHITE : BLACK;
  if (contrast(target, against) < ratio) {
    return target;
  }
  // Whole channel values, as the color is written: rounding must not take it below the ratio.
  const at = (t: number): Rgba => {
    const mixed = mix(target, opaque, t);
    return { r: Math.round(mixed.r), g: Math.round(mixed.g), b: Math.round(mixed.b), a: 1 };
  };
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i++) {
    const t = (low + high) / 2;
    if (contrast(at(t), against) >= ratio) {
      high = t;
    } else {
      low = t;
    }
  }
  return at(high);
}

/** Hue in degrees and HSL saturation (0 to 1). */
function hueAndSaturation(color: Rgba): { hue: number; saturation: number } {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) {
    return { hue: 0, saturation: 0 };
  }
  const lightness = (max + min) / 2;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation };
}

function distance(a: Rgba, b: Rgba): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/** Lines and outlines: the accent at 3:1 against the editor's background. */
const LINE_KEYS = [
  'focusBorder',
  'tab-activeBorderTop',
  'list-focusOutline',
  'list-focusAndSelectionOutline',
  'settings-focusedRowBorder',
  'sash-hoverBorder',
  'inputOption-activeBorder',
  'radio-activeBorder',
  'progressBar-background',
  'panelTitle-activeBorder',
  'activityBar-activeBorder',
  'statusBarItem-focusBorder',
  'notebook-focusedCellBorder',
  'notebook-focusedEditorBorder',
  'terminal-tab.activeBorder',
];

/** Filled controls: [background, foreground, hover background]. */
const FILL_KEYS: readonly (readonly [string, string, string?])[] = [
  ['button-background', 'button-foreground', 'button-hoverBackground'],
  ['extensionButton-prominentBackground', 'extensionButton-prominentForeground', 'extensionButton-prominentHoverBackground'],
  ['menu-selectionBackground', 'menu-selectionForeground'],
  ['activityBarBadge-background', 'activityBarBadge-foreground'],
  ['panelTitleBadge-background', 'panelTitleBadge-foreground'],
];

/** Selections and tints: [background, foreground or none, the surface they lie on]. */
const TINT_KEYS: readonly (readonly [string, string | undefined, string])[] = [
  ['list-activeSelectionBackground', 'list-activeSelectionForeground', 'sideBar-background'],
  ['quickInputList-focusBackground', 'quickInputList-focusForeground', 'quickInput-background'],
  ['editorSuggestWidget-selectedBackground', 'editorSuggestWidget-selectedForeground', 'editorSuggestWidget-background'],
  ['editorActionList-focusBackground', 'editorActionList-focusForeground', 'editorActionList-background'],
  ['inputOption-activeBackground', 'inputOption-activeForeground', 'editor-background'],
];

/** Highlighted text: the accent at 4.5:1 against the editor's background. */
const TEXT_KEYS = [
  'list-highlightForeground',
  'list-focusHighlightForeground',
  'quickInputList-focusHighlightForeground',
  'editorSuggestWidget-highlightForeground',
  'editorSuggestWidget-focusHighlightForeground',
  'editorHoverWidget-highlightForeground',
  'pickerGroup-foreground',
];

/** How far a hue may be from the theme's accent and still be its (degrees). */
const HUE_TOLERANCE = 30;

/**
 * The logo's color in a window with this accent (`#rrggbb`, or undefined for none): the
 * accent, but the logo's own orange for Claude's (the subscription, the Anthropic API) and
 * for none, so that such windows show the app's icon as it is.
 */
export function logoColor(accent: string | undefined): string {
  const color = parseColor(accent);
  const hex = color ? formatColor({ ...color, a: 1 }) : undefined;
  return hex === undefined || hex === CLAUDE_ACCENT ? LOGO_COLOR : hex;
}

/**
 * The theme with the window's accent: `accent` is `#rrggbb` or undefined (the theme's own
 * colors, no line). See the file's comment for what changes.
 */
export function withAccent(theme: ThemeData, accent: string | undefined): ThemeData {
  const vars = theme.variables;
  const get = (key: string): Rgba | undefined => parseColor(vars[`vscode-${key}`]);
  const editor = get('editor-background') ?? { r: 31, g: 31, b: 31, a: 1 };
  const titleBar = over(get('titleBar-activeBackground') ?? editor, editor);
  const logo = formatColor(ensureContrast(parseColor(logoColor(accent))!, titleBar, 3));
  const color = parseColor(accent);
  if (!color) {
    return { ...theme, variables: { ...vars, ...PAGE_ACCENT_UNSET, 'vilaus-accent': 'transparent', 'vilaus-logo': logo } };
  }
  const overrides: Record<string, string> = {
    ...PAGE_ACCENT_UNSET,
    'vilaus-accent': formatColor(ensureContrast(color, titleBar, 3)),
    'vilaus-logo': logo,
  };
  const highContrast = theme.kind === 'vscode-high-contrast' || theme.kind === 'vscode-high-contrast-light';
  const own = get('focusBorder');
  const ownHue = own ? hueAndSaturation(own) : undefined;
  if (highContrast || !own || !ownHue || ownHue.saturation < 0.3) {
    return { ...theme, variables: { ...vars, ...overrides } };
  }
  const isAccentLike = (key: string): boolean => {
    const value = get(key);
    if (!value) {
      return false;
    }
    const { hue, saturation } = hueAndSaturation(value);
    const apart = Math.abs(hue - ownHue.hue);
    return saturation >= 0.25 && Math.min(apart, 360 - apart) <= HUE_TOLERANCE;
  };
  const set = (key: string, value: Rgba): void => {
    overrides[`vscode-${key}`] = formatColor(value);
  };

  const line = ensureContrast(color, editor, 3);
  for (const key of LINE_KEYS) {
    if (isAccentLike(key)) {
      set(key, line);
    }
  }

  // A fill the background can see; darker if needed, so that white text reads on it.
  const forWhite = ensureContrast(line, WHITE, 4.5);
  const [fill, fillText] = contrast(forWhite, editor) >= 3 ? [forWhite, WHITE] : [line, contrast(BLACK, line) >= contrast(WHITE, line) ? BLACK : WHITE];
  const hover = luminance(fill) < 0.03 ? mix(WHITE, fill, 0.1) : mix(BLACK, fill, 0.1);
  overrides['vilaus-accent-line'] = formatColor(line);
  overrides['vilaus-accent-fill'] = formatColor(fill);
  overrides['vilaus-accent-fill-foreground'] = formatColor(fillText);
  for (const [background, foreground, hoverKey] of FILL_KEYS) {
    if (isAccentLike(background)) {
      set(background, fill);
      set(foreground, fillText);
      if (hoverKey && vars[`vscode-${hoverKey}`] !== undefined) {
        set(hoverKey, hover);
      }
    }
  }

  // As far from its surface as the theme's own was, relative to the theme's accent.
  for (const [background, foreground, surfaceKey] of TINT_KEYS) {
    const value = get(background);
    if (!value || !isAccentLike(background)) {
      continue;
    }
    const surface = over(get(surfaceKey) ?? editor, editor);
    const reach = distance(own, surface);
    const strength = reach > 0 ? Math.min(1, Math.max(0.15, distance(over(value, surface), surface) / reach)) : 0.4;
    const tint = mix(line, surface, strength);
    set(background, tint);
    if (foreground) {
      const text = get(foreground);
      if (!text || contrast(text, tint) < 4.5) {
        set(foreground, contrast(WHITE, tint) >= contrast(BLACK, tint) ? WHITE : BLACK);
      }
    }
  }

  const text = ensureContrast(color, editor, 4.5);
  for (const key of TEXT_KEYS) {
    if (isAccentLike(key)) {
      set(key, text);
    }
  }
  return { ...theme, variables: { ...vars, ...overrides } };
}
