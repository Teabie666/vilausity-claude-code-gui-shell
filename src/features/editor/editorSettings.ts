/**
 * The editor settings vilaus honours (VS Code's names and defaults), and how they become
 * Monaco options. Fonts reach Monaco through the theme's font variables (main computes them
 * from these same settings), so webviews and editors agree on them.
 */

import { SettingsSection } from '../../core/messages';
import type { SettingDefinition, SettingsService } from '../../core/settings';
import { DEFAULT_FONTS } from '../../platform/defaults';
import { AUTO_SAVE_MODES, DEFAULT_AUTO_SAVE_DELAY_MS } from './autoSave';
import { t } from './messages';

/** Keys whose change concerns editors. */
export function isEditorSetting(key: string): boolean {
  return key.startsWith('editor.') || key.startsWith('diffEditor.');
}

export function editorSettingDefinitions(): SettingDefinition[] {
  const text = t('sectionTextEditor');
  const diff = t('sectionDiffEditor');
  let order = 0;
  const editor = (key: string, schema: SettingDefinition['schema']): SettingDefinition => ({ key, schema, section: text, order: order++ });
  const diffEditor = (key: string, schema: SettingDefinition['schema']): SettingDefinition => ({
    key,
    schema,
    section: diff,
    order: order++,
  });
  // The rest of Monaco's diff options under VS Code's names: settings.json only, like the
  // editor options from `monacoOptionDefinitions` (Monaco keeps no schemas for these).
  const diffOption = (key: string, schema: SettingDefinition['schema']): SettingDefinition => ({
    ...diffEditor(key, schema),
    hidden: true,
  });
  // Shown with their description: the title alone does not say how the value is read.
  const described = (definition: SettingDefinition): SettingDefinition => ({ ...definition, showDescription: true });
  // With every other font (features/fonts), after the UI's and the conversation's.
  const font = (key: string, schema: SettingDefinition['schema'], fontOrder: number): SettingDefinition => ({
    key,
    schema,
    section: SettingsSection.fonts,
    order: 20 + fontOrder,
  });
  return [
    font('editor.fontFamily', { type: 'string', default: DEFAULT_FONTS.editorFamily, description: t('fontFamily') }, 0),
    font('editor.fontSize', { type: 'number', default: DEFAULT_FONTS.editorSize, minimum: 6, maximum: 100, description: t('fontSize') }, 1),
    font(
      'editor.fontWeight',
      {
        type: 'string',
        default: DEFAULT_FONTS.editorWeight,
        enum: ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'],
        description: t('fontWeight'),
      },
      2,
    ),
    // First in the section: someone new to editors looks for it there (features/editor/autoSave.ts).
    editor('files.autoSave', {
      type: 'string',
      default: 'off',
      enum: [...AUTO_SAVE_MODES],
      enumDescriptions: [t('autoSaveOff'), t('autoSaveAfterDelay'), t('autoSaveOnFocusChange'), t('autoSaveOnWindowChange')],
      description: t('autoSave'),
    }),
    described(
      editor('files.autoSaveDelay', { type: 'number', default: DEFAULT_AUTO_SAVE_DELAY_MS, minimum: 0, description: t('autoSaveDelay') }),
    ),
    described(editor('editor.lineHeight', { type: 'number', default: 0, minimum: 0, maximum: 150, description: t('lineHeight') })),
    editor('editor.fontLigatures', { type: 'boolean', default: false, description: t('fontLigatures') }),
    editor('editor.tabSize', { type: 'number', default: 4, minimum: 1, maximum: 100, description: t('tabSize') }),
    editor('editor.insertSpaces', { type: 'boolean', default: true, description: t('insertSpaces') }),
    editor('editor.detectIndentation', { type: 'boolean', default: true, description: t('detectIndentation') }),
    editor('editor.wordWrap', {
      type: 'string',
      default: 'off',
      enum: ['off', 'on', 'wordWrapColumn', 'bounded'],
      enumDescriptions: [t('wordWrapOff'), t('wordWrapOn'), t('wordWrapColumn'), t('wordWrapBounded')],
      description: t('wordWrap'),
    }),
    described(editor('editor.wordWrapColumn', { type: 'number', default: 80, minimum: 1, description: t('wordWrapColumnSetting') })),
    editor('editor.lineNumbers', {
      type: 'string',
      default: 'on',
      enum: ['off', 'on', 'relative', 'interval'],
      description: t('lineNumbers'),
    }),
    editor('editor.minimap.enabled', { type: 'boolean', default: true, description: t('minimap') }),
    editor('editor.renderWhitespace', {
      type: 'string',
      default: 'selection',
      enum: ['none', 'boundary', 'selection', 'trailing', 'all'],
      description: t('renderWhitespace'),
    }),
    editor('editor.bracketPairColorization.enabled', { type: 'boolean', default: true, description: t('bracketPairs') }),
    editor('editor.cursorBlinking', {
      type: 'string',
      default: 'blink',
      enum: ['blink', 'smooth', 'phase', 'expand', 'solid'],
      description: t('cursorBlinking'),
    }),
    editor('editor.smoothScrolling', { type: 'boolean', default: false, description: t('smoothScrolling') }),
    editor('editor.scrollBeyondLastLine', { type: 'boolean', default: true, description: t('scrollBeyondLastLine') }),
    described(diffEditor('diffEditor.fontFamily', { type: 'string', default: '', description: t('diffFontFamily') })),
    described(diffEditor('diffEditor.fontSize', { type: 'number', default: 0, minimum: 0, maximum: 100, description: t('diffFontSize') })),
    diffEditor('diffEditor.renderSideBySide', { type: 'boolean', default: true, description: t('renderSideBySide') }),
    described(
      diffEditor('diffEditor.useInlineViewWhenSpaceIsLimited', { type: 'boolean', default: true, description: t('inlineWhenNarrow') }),
    ),
    diffEditor('diffEditor.ignoreTrimWhitespace', { type: 'boolean', default: true, description: t('ignoreTrimWhitespace') }),
    diffEditor('diffEditor.wordWrap', {
      type: 'string',
      default: 'inherit',
      enum: ['off', 'on', 'inherit'],
      description: t('diffWordWrap'),
    }),
    diffOption('diffEditor.renderSideBySideInlineBreakpoint', {
      type: 'number',
      default: 900,
      minimum: 0,
      description: t('diffInlineBreakpoint'),
    }),
    diffOption('diffEditor.maxComputationTime', { type: 'number', default: 5000, minimum: 0, description: t('diffMaxComputationTime') }),
    diffOption('diffEditor.maxFileSize', { type: 'number', default: 50, minimum: 0, description: t('diffMaxFileSize') }),
    diffOption('diffEditor.renderIndicators', { type: 'boolean', default: true, description: t('diffRenderIndicators') }),
    diffOption('diffEditor.renderMarginRevertIcon', { type: 'boolean', default: true, description: t('diffRenderMarginRevertIcon') }),
    diffOption('diffEditor.renderGutterMenu', { type: 'boolean', default: true, description: t('diffRenderGutterMenu') }),
    diffOption('diffEditor.diffAlgorithm', {
      type: 'string',
      default: 'advanced',
      enum: ['legacy', 'advanced'],
      enumDescriptions: [t('diffAlgorithmLegacy'), t('diffAlgorithmAdvanced')],
      description: t('diffAlgorithm'),
    }),
    diffOption('diffEditor.hideUnchangedRegions.enabled', { type: 'boolean', default: false, description: t('hideUnchangedRegions') }),
    diffOption('diffEditor.hideUnchangedRegions.revealLineCount', {
      type: 'integer',
      default: 20,
      minimum: 1,
      description: t('hideUnchangedRevealLineCount'),
    }),
    diffOption('diffEditor.hideUnchangedRegions.minimumLineCount', {
      type: 'integer',
      default: 3,
      minimum: 1,
      description: t('hideUnchangedMinimumLineCount'),
    }),
    diffOption('diffEditor.hideUnchangedRegions.contextLineCount', {
      type: 'integer',
      default: 3,
      minimum: 1,
      description: t('hideUnchangedContextLineCount'),
    }),
    diffOption('diffEditor.experimental.showMoves', { type: 'boolean', default: false, description: t('diffShowMoves') }),
    diffOption('diffEditor.experimental.showEmptyDecorations', {
      type: 'boolean',
      default: true,
      description: t('diffShowEmptyDecorations'),
    }),
    diffOption('diffEditor.experimental.useTrueInlineView', { type: 'boolean', default: false, description: t('diffTrueInlineView') }),
  ];
}

/**
 * Every Monaco editor option as a setting, from Monaco's own schemas (VS Code builds its
 * `editor.*` settings from the same ones, descriptions included in the display language).
 * They go into settings.json's schema but not the settings editor, which lists the common
 * ones above. A schema is either one setting's (`editor.<name>`) or a map of full keys.
 */
export function monacoOptionDefinitions(
  options: Readonly<Record<string, unknown>>,
  section: string,
  isDeclared: (key: string) => boolean,
): SettingDefinition[] {
  const definitions: SettingDefinition[] = [];
  for (const option of Object.values(options) as { name?: unknown; schema?: unknown }[]) {
    const schema = option.schema;
    if (typeof option.name !== 'string' || typeof schema !== 'object' || schema === null) {
      continue;
    }
    const single = 'type' in schema || 'anyOf' in schema || 'enum' in schema;
    const entries = single ? [[`editor.${option.name}`, schema] as const] : Object.entries(schema);
    for (const [key, value] of entries) {
      if (key.startsWith('editor.') && typeof value === 'object' && value !== null && !isDeclared(key)) {
        definitions.push({ key, schema: value as SettingDefinition['schema'], section, hidden: true });
      }
    }
  }
  return definitions;
}

/**
 * The user's `<prefix>*` settings as nested Monaco options: `editor.minimap.side` ->
 * `{ minimap: { side } }`. Lets settings.json reach every option declared as a setting.
 */
export function nestedOptions(
  values: Readonly<Record<string, unknown>>,
  prefix: string,
  rename: Readonly<Record<string, string>> = {},
  skip: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const path = key.slice(prefix.length).split('.');
    if (path.some((segment) => segment === '' || segment === '__proto__') || skip.has(path[0]!)) {
      continue;
    }
    path[0] = rename[path[0]!] ?? path[0]!;
    let target = options;
    for (const segment of path.slice(0, -1)) {
      const next = target[segment];
      target = (typeof next === 'object' && next !== null ? next : (target[segment] = {})) as Record<string, unknown>;
    }
    target[path[path.length - 1]!] = value;
  }
  return options;
}

/** `extra` over `base`, merging nested objects (`minimap: { enabled }` and `minimap: { side }`). */
export function mergeOptions(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const current = merged[key];
    const bothObjects =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current);
    merged[key] = bothObjects ? mergeOptions(current as Record<string, unknown>, value as Record<string, unknown>) : value;
  }
  return merged;
}

/** Monaco options from the editor settings: the common ones with their defaults, then the rest set under `editor.`. */
export function editorOptions(settings: SettingsService): Record<string, unknown> {
  return mergeOptions(commonEditorOptions(settings), nestedOptions(declaredValues(settings), 'editor.', {}, NOT_EDITOR_OPTIONS));
}

/**
 * The values of declared settings only, as in VS Code: Monaco also has options no setting
 * should reach (`readOnly`, `automaticLayout`, the global `theme`).
 */
function declaredValues(settings: SettingsService): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings.values).filter(([key]) => settings.definition(key) !== undefined));
}

/** Editor settings that reach editors another way: fonts through the theme, indentation through the models. */
const NOT_EDITOR_OPTIONS = new Set(['fontFamily', 'fontSize', 'fontWeight', 'tabSize', 'insertSpaces', 'detectIndentation']);

function commonEditorOptions(settings: SettingsService): Record<string, unknown> {
  return {
    lineHeight: settings.get('editor.lineHeight', 0),
    fontLigatures: settings.get('editor.fontLigatures', false),
    wordWrap: settings.get('editor.wordWrap', 'off'),
    wordWrapColumn: settings.get('editor.wordWrapColumn', 80),
    lineNumbers: settings.get('editor.lineNumbers', 'on'),
    minimap: { enabled: settings.get('editor.minimap.enabled', true) },
    renderWhitespace: settings.get('editor.renderWhitespace', 'selection'),
    bracketPairColorization: { enabled: settings.get('editor.bracketPairColorization.enabled', true) },
    cursorBlinking: settings.get('editor.cursorBlinking', 'blink'),
    smoothScrolling: settings.get('editor.smoothScrolling', false),
    scrollBeyondLastLine: settings.get('editor.scrollBeyondLastLine', true),
  };
}

/**
 * The diff editor's own options, on top of `editorOptions`: the common ones, everything else
 * set under `diffEditor.` (VS Code's `diffEditor.wordWrap` is Monaco's `diffWordWrap`), and
 * its own font when set (else the editor's).
 */
export function diffEditorOptions(settings: SettingsService): Record<string, unknown> {
  const common = {
    renderSideBySide: settings.get('diffEditor.renderSideBySide', true),
    useInlineViewWhenSpaceIsLimited: settings.get('diffEditor.useInlineViewWhenSpaceIsLimited', true),
    ignoreTrimWhitespace: settings.get('diffEditor.ignoreTrimWhitespace', true),
    diffWordWrap: settings.get('diffEditor.wordWrap', 'inherit'),
  };
  const options = mergeOptions(
    common,
    nestedOptions(declaredValues(settings), 'diffEditor.', { wordWrap: 'diffWordWrap' }, DIFF_FONT_KEYS),
  );
  const fontFamily = settings.get('diffEditor.fontFamily', '');
  const fontSize = settings.get('diffEditor.fontSize', 0);
  if (typeof fontFamily === 'string' && fontFamily.trim()) {
    options.fontFamily = fontFamily;
  }
  if (typeof fontSize === 'number' && fontSize > 0) {
    options.fontSize = fontSize;
  }
  return options;
}

/** Applied above, and only when set. */
const DIFF_FONT_KEYS = new Set(['fontFamily', 'fontSize']);

/** Indentation of a text model: detected from its text, or the configured one. */
export function indentation(settings: SettingsService): { tabSize: number; insertSpaces: boolean; detect: boolean } {
  return {
    tabSize: settings.get('editor.tabSize', 4),
    insertSpaces: settings.get('editor.insertSpaces', true),
    detect: settings.get('editor.detectIndentation', true),
  };
}
