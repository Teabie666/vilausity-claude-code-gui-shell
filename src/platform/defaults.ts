/**
 * Defaults of settings that main applies and the settings editor shows: they must agree.
 */

/**
 * The default fonts. Main turns the font settings (or these) into the theme's font variables.
 * Latin text follows VS Code on Windows everywhere (Segoe UI; Consolas for code); Chinese text
 * takes Microsoft YaHei UI in the UI and the bundled Noto Sans SC (Source Han Sans' glyphs) in
 * the conversation, so the two read apart. Code keeps the system's fallback for Chinese.
 */
export const DEFAULT_FONTS = {
  family: '"Segoe WPC", "Segoe UI", "Microsoft YaHei UI", sans-serif',
  size: 13,
  /** The conversation (`chat.fontFamily`, `chat.fontSize`) and, unless set, Markdown previews. */
  chatFamily: '"Segoe WPC", "Segoe UI", "Noto Sans SC", "Microsoft YaHei", sans-serif',
  chatSize: 14,
  chatLineHeight: 1.6,
  /** Code in the conversation (`chat.editor.fontSize`); its font is the editor's unless set. */
  chatCodeSize: 13,
  editorFamily: "Consolas, 'Courier New', monospace",
  editorSize: 14,
  editorWeight: 'normal',
  markdownSize: 14,
  markdownLineHeight: 1.6,
} as const;

/**
 * VS Code's value of `chat.editor.fontFamily` (and of `chat.fontFamily`) that means "the
 * default font"; an empty string means the same.
 */
export const DEFAULT_FONT_VALUE = 'default';

/** The color theme when `vilaus.theme` is not set. */
export const DEFAULT_THEME_ID = 'dark-modern';

/**
 * Keep Claude Code's conversations: main sets Claude Code's own `cleanupPeriodDays` (30 days
 * unless set) when it is not set (host/main/claudeRetention.ts). On by default.
 */
export const KEEP_SESSIONS_SETTING = 'vilaus.sessions.keepForever';
export const KEEP_SESSIONS_DEFAULT = true;
