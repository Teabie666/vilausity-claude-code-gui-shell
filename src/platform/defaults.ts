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
 * How long Claude Code keeps conversations nobody goes on with: main writes it into Claude
 * Code's own `cleanupPeriodDays` (30 days unless set; host/main/claudeRetention.ts). 0, the
 * default: never deleted.
 */
export const DELETE_SESSIONS_SETTING = 'vilaus.sessions.deleteAfterDays';
export const DELETE_SESSIONS_CHOICES = [0, 30, 60, 90, 180, 365] as const;
/** What came before it: on (the default) kept them for good; off left Claude Code's 30 days. */
export const LEGACY_KEEP_SESSIONS_SETTING = 'vilaus.sessions.keepForever';
/** The session list shows only the conversations active in the last so many days; 0, the default: all. */
export const SHOW_SESSIONS_SETTING = 'vilaus.sessions.showWithinDays';
export const SHOW_SESSIONS_CHOICES = [0, 7, 30, 90, 180, 365] as const;
