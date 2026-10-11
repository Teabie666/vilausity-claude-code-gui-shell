/** Text of the color theme picker, and the names of the built-in themes. */

import { defineMessages, defineNames } from '../../platform/nls';

export const t = defineMessages('themes', {
  colorTheme: 'Color Theme',
  selectColorTheme: 'Select Color Theme',
  current: 'current',
  themeSetting: 'The color theme of Vilausity, its editors and the Claude Code views.',
  accentSetting:
    "The accent color of the window: the line along its top, the active tab's line, buttons, focus outlines, selections and highlights.",
  accentProvider: 'Follow the API Provider',
  accentCustom: 'Custom Color',
  accentVscode: "VS Code's Default",
  accentColorSetting: 'The accent color when Accent is set to a color of your own.',
});

/**
 * Theme names come with the captured theme data (English). These are the ones to
 * translate; a theme captured later keeps its own label until it is added here.
 */
const themeName = defineNames('themeNames', {
  'dark-modern': 'Dark Modern',
  'light-modern': 'Light Modern',
  'dark-plus': 'Dark+',
  'light-plus': 'Light+',
  'hc-dark': 'High Contrast Dark',
  'hc-light': 'High Contrast Light',
});

/** A theme's name in the UI language. */
export function themeLabel(id: string, label: string): string {
  return themeName(id, label);
}
