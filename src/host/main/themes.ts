/**
 * Built-in themes are JSON snapshots of VS Code's theme variables, produced by
 * tools/theme-capture and shipped in `<app>/themes/<id>.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_FONT_VALUE, DEFAULT_FONTS, DEFAULT_THEME_ID } from '../../platform/defaults';
import type { ILogger } from '../../platform/log';
import type { ThemeData, ThemeSummary } from '../../platform/protocol';
import { readJsonFile } from '../node/jsonFile';

export { DEFAULT_THEME_ID } from '../../platform/defaults';

export function listThemeSummaries(themesDir: string): ThemeSummary[] {
  let names: string[];
  try {
    names = fs.readdirSync(themesDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const theme = readJsonFile<ThemeData | undefined>(path.join(themesDir, name), undefined);
    return theme ? [{ id: theme.id, label: theme.label, kind: theme.kind }] : [];
  });
}

/** The settings `withFontVariables` reads: a change to one of them changes the theme data. */
export const FONT_SETTING_KEYS = [
  'workbench.fontFamily',
  'workbench.fontSize',
  'chat.fontFamily',
  'chat.fontSize',
  'chat.editor.fontFamily',
  'chat.editor.fontSize',
  'editor.fontFamily',
  'editor.fontSize',
  'editor.fontWeight',
  'markdown.preview.fontFamily',
  'markdown.preview.fontSize',
  'markdown.preview.lineHeight',
] as const;

/**
 * Adds the font variables from settings (VS Code setting names) or defaults. Fonts are user
 * settings, never part of a captured theme.
 * - `--vscode-font-*`: the UI, the shell's and the extension's own (its buttons, menus,
 *   session list);
 * - `--vilaus-chat-*`: the conversation's text and the code in it, which the extension's pages
 *   apply (bridge.ts);
 * - `--vscode-editor-font-*`: the code editors;
 * - `--vscode-markdown-*`: Markdown previews.
 */
export function withFontVariables(theme: ThemeData, settings: Readonly<Record<string, unknown>>): ThemeData {
  const text = (key: string, fallback: string): string => {
    const value = settings[key];
    return typeof value === 'string' && value.trim() && value.trim() !== DEFAULT_FONT_VALUE ? value : fallback;
  };
  const number = (key: string, fallback: number): number => {
    const value = settings[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const size = (key: string, fallback: number): string => `${number(key, fallback)}px`;
  const editorFamily = text('editor.fontFamily', DEFAULT_FONTS.editorFamily);
  const chatFamily = text('chat.fontFamily', DEFAULT_FONTS.chatFamily);
  return {
    ...theme,
    variables: {
      ...theme.variables,
      'vscode-font-family': text('workbench.fontFamily', DEFAULT_FONTS.family),
      'vscode-font-weight': 'normal',
      'vscode-font-size': size('workbench.fontSize', DEFAULT_FONTS.size),
      'vilaus-chat-font-family': chatFamily,
      'vilaus-chat-font-size': size('chat.fontSize', DEFAULT_FONTS.chatSize),
      'vilaus-chat-line-height': String(DEFAULT_FONTS.chatLineHeight),
      // VS Code's "default" for code in chat: the editor's font.
      'vilaus-chat-code-font-family': text('chat.editor.fontFamily', editorFamily),
      'vilaus-chat-code-font-size': size('chat.editor.fontSize', DEFAULT_FONTS.chatCodeSize),
      'vscode-editor-font-family': editorFamily,
      'vscode-editor-font-weight': text('editor.fontWeight', DEFAULT_FONTS.editorWeight),
      'vscode-editor-font-size': size('editor.fontSize', DEFAULT_FONTS.editorSize),
      // An empty font family: the conversation's.
      'vscode-markdown-font-family': text('markdown.preview.fontFamily', chatFamily),
      'vscode-markdown-font-size': size('markdown.preview.fontSize', DEFAULT_FONTS.markdownSize),
      'vscode-markdown-line-height': String(number('markdown.preview.lineHeight', DEFAULT_FONTS.markdownLineHeight)),
    },
  };
}

/** The bundled fonts' @font-face rules (scripts/build.mjs, copyFonts), for webviews; empty when missing. */
export function readFontFaces(file: string, logger: ILogger): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    logger.warn(`no bundled fonts at ${file}`, error);
    return '';
  }
}

export function loadTheme(themesDir: string, id: string, logger: ILogger): ThemeData {
  const theme = readJsonFile<ThemeData | undefined>(path.join(themesDir, `${id}.json`), undefined);
  if (theme && typeof theme.variables === 'object') {
    return theme;
  }
  if (id !== DEFAULT_THEME_ID) {
    logger.warn(`theme ${id} not found; falling back to ${DEFAULT_THEME_ID}`);
    return loadTheme(themesDir, DEFAULT_THEME_ID, logger);
  }
  logger.warn('no captured themes found; using the minimal fallback theme');
  return FALLBACK_THEME;
}

/** Enough to keep the UI legible before themes have been captured. */
const FALLBACK_THEME: ThemeData = {
  id: 'fallback-dark',
  label: 'Fallback Dark',
  kind: 'vscode-dark',
  variables: {
    'vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif',
    'vscode-font-weight': 'normal',
    'vscode-font-size': '13px',
    'vscode-editor-font-family': 'Consolas, "Courier New", monospace',
    'vscode-editor-font-weight': 'normal',
    'vscode-editor-font-size': '14px',
    'vscode-foreground': '#cccccc',
    'vscode-descriptionForeground': '#9d9d9d',
    'vscode-errorForeground': '#f85149',
    'vscode-focusBorder': '#0078d4',
    'vscode-editor-background': '#1f1f1f',
    'vscode-editor-foreground': '#cccccc',
    'vscode-sideBar-background': '#181818',
    'vscode-titleBar-activeBackground': '#181818',
    'vscode-titleBar-activeForeground': '#cccccc',
    'vscode-panel-border': '#2b2b2b',
    'vscode-input-background': '#313131',
    'vscode-input-foreground': '#cccccc',
    'vscode-input-border': '#3c3c3c',
    'vscode-button-background': '#0078d4',
    'vscode-button-foreground': '#ffffff',
    'vscode-button-hoverBackground': '#026ec1',
    'vscode-textLink-foreground': '#4daafc',
    'vscode-textLink-activeForeground': '#4daafc',
    'vscode-scrollbarSlider-background': 'rgba(121, 121, 121, 0.4)',
    'vscode-scrollbarSlider-hoverBackground': 'rgba(100, 100, 100, 0.7)',
    'vscode-scrollbarSlider-activeBackground': 'rgba(191, 191, 191, 0.4)',
    'vscode-widget-shadow': 'rgba(0, 0, 0, 0.36)',
    'vscode-tab-activeBackground': '#1f1f1f',
    'vscode-tab-inactiveBackground': '#181818',
    'vscode-tab-activeForeground': '#ffffff',
    'vscode-tab-inactiveForeground': '#9d9d9d',
    'vscode-tab-border': '#2b2b2b',
  },
};
