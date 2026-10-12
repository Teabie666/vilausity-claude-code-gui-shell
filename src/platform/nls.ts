/**
 * Shell UI text. The code holds English only: each module defines its strings with
 * `defineMessages(namespace, english)` in its own messages.ts, and keys are type-checked.
 * Other languages come from language packs (src/nls/<language>.json, keys
 * `namespace.key`); a string a pack does not have yet shows in English, so features can be
 * written in English first and translated later. `npm run nls` lists what a pack lacks.
 *
 * The language is fixed per process at startup (main decides it and passes it on);
 * changing it takes a restart, as in VS Code. Logs and code comments stay English.
 */

export type UiLanguage = 'en' | 'zh-cn';

/** The `vilaus.language` setting: a language, or `auto` to follow the system. */
export type UiLanguageSetting = UiLanguage | 'auto';

export const LANGUAGE_SETTING = 'vilaus.language';

/** How each language names itself, e.g. in the language picker. */
export const LANGUAGE_NAMES: Readonly<Record<UiLanguage, string>> = {
  en: 'English',
  'zh-cn': '中文（简体）',
};

/** Translations for one language: `namespace.key` -> text. */
export type LanguagePack = Readonly<Record<string, string>>;

let current: UiLanguage = 'en';
let translations: LanguagePack = {};

/** The English strings of every namespace defined so far, to check packs against. */
const registry = new Map<string, Readonly<Record<string, string>>>();

/** Sets this process's language, with the pack to translate from (unused for English). */
export function setUiLanguage(language: UiLanguage, pack: LanguagePack = {}): void {
  current = language;
  translations = language === 'en' ? {} : pack;
}

export function getUiLanguage(): UiLanguage {
  return current;
}

/** `t('key', ...args)`: the string in the current language, `{0}`, `{1}`... filled in. */
export type Localize<K extends string> = (key: K, ...args: readonly (string | number)[]) => string;

function register(namespace: string, english: Readonly<Record<string, string>>): void {
  if (registry.has(namespace)) {
    throw new Error(`nls namespace "${namespace}" is defined twice`);
  }
  registry.set(namespace, english);
}

/** A module's strings: English here, other languages from the pack as `namespace.key`. */
export function defineMessages<K extends string>(namespace: string, english: Readonly<Record<K, string>>): Localize<K> {
  register(namespace, english);
  // An empty translation counts as missing.
  return (key, ...args) => format(translations[`${namespace}.${key}`] || english[key], args);
}

/**
 * Names that come from data, such as theme ids or extension command ids. `english` lists
 * the ids that should be translated (the packs are checked against it); at runtime an id
 * without a translation keeps the caller's own text, so new data still shows up.
 */
export function defineNames(namespace: string, english: Readonly<Record<string, string>>): (id: string, fallback: string) => string {
  register(namespace, english);
  return (id, fallback) => translations[`${namespace}.${id}`] || fallback;
}

/**
 * Compares a pack with the strings defined so far: `missing` maps each untranslated key
 * to its English text (what a translator needs), `stale` lists entries nothing uses.
 */
export function checkPack(pack: LanguagePack): { missing: Record<string, string>; stale: string[] } {
  const english = new Map<string, string>();
  for (const [namespace, strings] of registry) {
    for (const [key, text] of Object.entries(strings)) {
      english.set(`${namespace}.${key}`, text);
    }
  }
  const missing: Record<string, string> = {};
  for (const [key, text] of english) {
    if (!pack[key]) {
      missing[key] = text;
    }
  }
  return { missing, stale: Object.keys(pack).filter((key) => !english.has(key)) };
}

/** Replaces `{0}`, `{1}`... with the arguments; a placeholder without an argument stays. */
export function format(template: string, args: readonly (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? placeholder : String(value);
  });
}

export function parseLanguageSetting(value: unknown): UiLanguageSetting {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'en' || normalized === 'zh-cn' ? normalized : 'auto';
}

/**
 * The language to show. `auto` follows the first of the system's preferred languages:
 * any Chinese variant gets Simplified Chinese (the closer of the two), everything else English.
 */
export function resolveUiLanguage(setting: unknown, systemLanguages: readonly string[]): UiLanguage {
  const parsed = parseLanguageSetting(setting);
  if (parsed !== 'auto') {
    return parsed;
  }
  return /^zh(?:-|_|$)/i.test(systemLanguages[0] ?? '') ? 'zh-cn' : 'en';
}

/** The `lang` attribute for a document in this language. */
export function htmlLang(language: UiLanguage): string {
  return language === 'zh-cn' ? 'zh-CN' : 'en';
}
