/**
 * API providers (M4): which service a window's Claude processes talk to, and how that
 * becomes their environment variables. Plain data and functions shared by main (which
 * alone holds the keys and computes the variables), the renderer (which edits providers)
 * and the tests.
 *
 * The Claude Code extension starts each Claude process with the variables of its
 * `claudeCode.environmentVariables` setting ({ name, value } entries, read at every start;
 * checked against 2.1.282). The shell lays the window's provider over that setting in the
 * extension host instead of writing a key into settings.json.
 */

import { readPricing, type ProviderPricing } from './pricing';

export type ProviderType = 'subscription' | 'anthropic-api' | 'compatible' | 'bedrock' | 'vertex' | 'foundry';

/** How the key goes out: `apiKey` as ANTHROPIC_API_KEY (x-api-key), `bearer` as ANTHROPIC_AUTH_TOKEN. */
export type AuthScheme = 'apiKey' | 'bearer';

export interface ProviderModels {
  /** ANTHROPIC_MODEL: what conversations start with. */
  readonly main?: string;
  /** ANTHROPIC_DEFAULT_<TIER>_MODEL: what the model picker's tiers mean. */
  readonly opus?: string;
  readonly sonnet?: string;
  readonly haiku?: string;
  readonly fable?: string;
  /** CLAUDE_CODE_SUBAGENT_MODEL */
  readonly subagent?: string;
}

// Prices and their rules live in pricing.ts; the providers carry them.
export { modelKey, type Currency, type ModelPrice, type ProviderPricing } from './pricing';

export interface ProviderConfig {
  /** Stable id, as `--provider <id>` names it: lowercase letters, digits and dashes. */
  readonly id: string;
  /** Empty for the built-in subscription, which the UI names itself. */
  readonly name: string;
  readonly type: ProviderType;
  readonly baseUrl?: string;
  readonly auth?: AuthScheme;
  readonly models?: ProviderModels;
  /** Extra request headers (ANTHROPIC_CUSTOM_HEADERS). */
  readonly headers?: Readonly<Record<string, string>>;
  /** API_TIMEOUT_MS */
  readonly timeoutMs?: number;
  /** CLAUDE_CODE_MAX_OUTPUT_TOKENS */
  readonly maxOutputTokens?: number;
  /** CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC */
  readonly disableNonessentialTraffic?: boolean;
  /** Any other variables, set last (they win over the fields above). */
  readonly env?: Readonly<Record<string, string>>;
  /** The accent color (#rrggbb) of windows that use it, when not its vendor's (`providerAccentColor`). */
  readonly color?: string;
  /** The preset it started from: its documentation link. */
  readonly preset?: string;
  readonly pricing?: ProviderPricing;
}

/** A provider as the renderer sees it: never the key, only whether there is one. */
export interface ProviderSummary extends ProviderConfig {
  readonly hasKey: boolean;
}

export const SUBSCRIPTION_ID = 'subscription';
export const SUBSCRIPTION_PROVIDER: ProviderConfig = { id: SUBSCRIPTION_ID, name: '', type: 'subscription' };

/** The setting with a new folder's provider (each folder then keeps its own). */
export const DEFAULT_PROVIDER_SETTING = 'vilaus.provider.default';
export const ENVIRONMENT_SETTING = 'claudeCode.environmentVariables';
export const DISABLE_LOGIN_SETTING = 'claudeCode.disableLoginPrompt';

const PROVIDER_TYPES: readonly ProviderType[] = ['subscription', 'anthropic-api', 'compatible', 'bedrock', 'vertex', 'foundry'];
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isProviderId(id: string): boolean {
  return PROVIDER_ID.test(id);
}

/** Claude's own accent: the subscription, the Anthropic API and the platforms that serve Claude. */
export const CLAUDE_ACCENT = '#d97757';

/**
 * Each preset's accent, its vendor's color, for providers that do not pick one. A provider
 * without a preset (or from "custom") that talks to another API has none: its windows keep the
 * theme's own accent unless it picks one.
 */
export const PRESET_ACCENTS: Readonly<Record<string, string>> = {
  anthropic: CLAUDE_ACCENT,
  deepseek: '#4d6bfe',
  kimi: '#3b2a5c',
  'kimi-intl': '#3b2a5c',
  glm: '#2b2b2b',
  zai: '#2b2b2b',
  'qwen-coding': '#8ab4f8',
  qwen: '#8ab4f8',
  'qwen-coding-intl': '#8ab4f8',
  'qwen-intl': '#8ab4f8',
  seed: '#1664ff',
  minimax: '#f23f5d',
  'minimax-intl': '#f23f5d',
  openrouter: '#6467f2',
};

/** The accent of windows that use a provider: its own pick, else its vendor's, else Claude's for Claude's APIs. */
export function providerAccentColor(provider: ProviderConfig): string | undefined {
  if (provider.color) {
    return provider.color;
  }
  const preset = provider.preset !== undefined ? PRESET_ACCENTS[provider.preset] : undefined;
  if (preset) {
    return preset;
  }
  return provider.type === 'compatible' ? undefined : CLAUDE_ACCENT;
}

/**
 * Colors that earlier versions stored with every provider (its preset's color then, or grey
 * when there was none) although nobody picked them; such a provider follows its vendor's
 * accent now. Applied to providers.json as it is read.
 */
const LEGACY_PRESET_COLORS: Readonly<Record<string, string>> = {
  anthropic: '#d97757',
  deepseek: '#4d6bfe',
  kimi: '#0ea5a4',
  'kimi-intl': '#0ea5a4',
  glm: '#e8833a',
  zai: '#e8833a',
  'qwen-coding': '#7c5cff',
  qwen: '#7c5cff',
  'qwen-coding-intl': '#7c5cff',
  'qwen-intl': '#7c5cff',
};
const LEGACY_DEFAULT_COLOR = '#8a8a8a';

export function withoutLegacyColor(provider: ProviderConfig): ProviderConfig {
  const color = provider.color;
  if (color === undefined) {
    return provider;
  }
  const legacy = color === LEGACY_DEFAULT_COLOR || (provider.preset !== undefined && LEGACY_PRESET_COLORS[provider.preset] === color);
  return legacy ? { ...provider, color: undefined } : provider;
}

/** A free id from a name: `Kimi (moonshot.ai)` -> `kimi-moonshot-ai`, then `-2`, `-3`... */
export function providerIdFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'provider';
  let id = base;
  for (let n = 2; taken.includes(id); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

/** A compatible API's ANTHROPIC_API_KEY while it has no key: anything but empty (`providerEnvironment`). */
export const NO_KEY = 'vilaus-no-key';

/** The Claude processes' variables for a provider, with its key. The subscription sets none. */
export function providerEnvironment(provider: ProviderConfig, key: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (provider.type === 'subscription') {
    return env;
  }
  const set = (name: string, value: string | number | undefined): void => {
    if (value !== undefined && value !== '') {
      env[name] = String(value);
    }
  };
  if (provider.type === 'bedrock') {
    env.CLAUDE_CODE_USE_BEDROCK = '1';
  } else if (provider.type === 'vertex') {
    env.CLAUDE_CODE_USE_VERTEX = '1';
  } else if (provider.type === 'foundry') {
    env.CLAUDE_CODE_USE_FOUNDRY = '1';
  } else {
    set('ANTHROPIC_BASE_URL', provider.baseUrl);
    const compatible = provider.type === 'compatible';
    const bearer = (provider.auth ?? (compatible ? 'bearer' : 'apiKey')) === 'bearer';
    // With no ANTHROPIC_API_KEY it takes (empty, or not approved: see the headers below), the CLI
    // sends the Anthropic API key of its own login (Claude Code signed in with a Console account)
    // as x-api-key, to whatever this base URL is. So a compatible API always gets one: its own
    // key, next to the bearer token too (both go to its own server), or a placeholder while it
    // has none. An Anthropic API provider falling back to the login stays with Anthropic.
    const apiKey = key || (compatible ? NO_KEY : '');
    // Either is set here: left over in the user's environment, it would win over ours.
    env.ANTHROPIC_API_KEY = bearer && !compatible ? '' : apiKey;
    env.ANTHROPIC_AUTH_TOKEN = bearer ? (key ?? '') : '';
  }
  const models = provider.models ?? {};
  set('ANTHROPIC_MODEL', models.main);
  set('ANTHROPIC_DEFAULT_OPUS_MODEL', models.opus);
  set('ANTHROPIC_DEFAULT_SONNET_MODEL', models.sonnet);
  set('ANTHROPIC_DEFAULT_HAIKU_MODEL', models.haiku);
  set('ANTHROPIC_DEFAULT_FABLE_MODEL', models.fable);
  set('CLAUDE_CODE_SUBAGENT_MODEL', models.subagent);
  const headers = Object.entries(provider.headers ?? {});
  // Under the extension (entry point claude-vscode) the CLI takes an ANTHROPIC_API_KEY only once
  // the user approved it in its own terminal UI; else it sends its login's key as x-api-key all
  // the same. A custom header wins over the SDK's own (seen with CLI 2.1.282 and 2.1.296).
  if (provider.type === 'compatible' && !headers.some(([name]) => name.toLowerCase() === 'x-api-key')) {
    headers.push(['x-api-key', key || NO_KEY]);
  }
  if (headers.length > 0) {
    env.ANTHROPIC_CUSTOM_HEADERS = headers.map(([name, value]) => `${name}: ${value}`).join('\n');
  }
  set('API_TIMEOUT_MS', provider.timeoutMs);
  set('CLAUDE_CODE_MAX_OUTPUT_TOKENS', provider.maxOutputTokens);
  if (provider.disableNonessentialTraffic) {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  }
  // No login: the extension shows none (disableLoginPrompt) and the CLI asks for none.
  env.CLAUDE_CODE_SKIP_AUTH_LOGIN = '1';
  Object.assign(env, provider.env);
  return env;
}

/** One `claudeCode.environmentVariables` entry, as the extension's setting declares them. */
export interface EnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * The extension settings a window's provider changes: the user's own variables with the
 * provider's laid over them (a name in both takes the provider's value; names compare
 * case-insensitively, as Windows does), and no login prompt. Nothing for the subscription.
 */
export function providerSettingsOverlay(
  provider: ProviderConfig,
  key: string | undefined,
  settings: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (provider.type === 'subscription') {
    return {};
  }
  const env = providerEnvironment(provider, key);
  const ours = new Set(Object.keys(env).map((name) => name.toUpperCase()));
  const own = environmentEntries(settings[ENVIRONMENT_SETTING]).filter((entry) => !ours.has(entry.name.toUpperCase()));
  return {
    [ENVIRONMENT_SETTING]: [...own, ...Object.entries(env).map(([name, value]) => ({ name, value }))],
    [DISABLE_LOGIN_SETTING]: true,
  };
}

export function environmentEntries(value: unknown): EnvironmentEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry: unknown) => {
    const candidate = entry as Partial<EnvironmentEntry> | null;
    return typeof candidate === 'object' && candidate !== null && typeof candidate.name === 'string'
      ? [{ name: candidate.name, value: String(candidate.value ?? '') }]
      : [];
  });
}

/** A provider read from disk or sent by the renderer, if it is one; unknown fields are dropped. */
export function parseProviderConfig(value: unknown): ProviderConfig | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !isProviderId(value.id)) {
    return undefined;
  }
  const type = PROVIDER_TYPES.find((candidate) => candidate === value.type);
  if (!type) {
    return undefined;
  }
  const text = (field: unknown): string | undefined => (typeof field === 'string' && field.trim() !== '' ? field.trim() : undefined);
  const count = (field: unknown): number | undefined =>
    typeof field === 'number' && Number.isInteger(field) && field > 0 ? field : undefined;
  const models = isRecord(value.models) ? value.models : {};
  const parsedModels: ProviderModels = {
    main: text(models.main),
    opus: text(models.opus),
    sonnet: text(models.sonnet),
    haiku: text(models.haiku),
    fable: text(models.fable),
    subagent: text(models.subagent),
  };
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name.trim() : '',
    type,
    baseUrl: text(value.baseUrl),
    auth: value.auth === 'apiKey' || value.auth === 'bearer' ? value.auth : undefined,
    models: Object.values(parsedModels).some((model) => model !== undefined) ? parsedModels : undefined,
    headers: stringMap(value.headers, (name) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)),
    timeoutMs: count(value.timeoutMs),
    maxOutputTokens: count(value.maxOutputTokens),
    disableNonessentialTraffic: value.disableNonessentialTraffic === true ? true : undefined,
    env: stringMap(value.env, (name) => ENV_NAME.test(name)),
    color: typeof value.color === 'string' && COLOR.test(value.color) ? value.color.toLowerCase() : undefined,
    preset: text(value.preset),
    pricing: parsePricing(value.pricing),
  };
}

function parsePricing(value: unknown): ProviderPricing | undefined {
  // Leniently: a model or rule that does not hold is left out, the rest kept.
  return isRecord(value) ? readPricing(value, false).answer?.pricing : undefined;
}

function stringMap(value: unknown, validName: (name: string) => boolean): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => validName(entry[0]) && typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
