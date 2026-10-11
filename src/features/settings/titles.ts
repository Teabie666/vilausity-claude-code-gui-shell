/**
 * Settings' titles in the display language. In English a title is derived from the key as
 * VS Code does (`editor.fontSize` -> `Editor: Font Size`); a translation is the name alone,
 * since the section already says where it belongs (`字号` under 文本编辑器). The keys with
 * a translation are listed in messages.ts (`settingTitleName`), so `npm run nls` checks them;
 * any other key (a newer extension's setting) keeps its derived title. The display language
 * setting keeps its English title, so that it can be found in a language one cannot read.
 */

import { settingTitleName } from './messages';
import { settingTitle } from './settingItems';

/** The title the settings editor shows: a translated name, or VS Code's derived category and name. */
export function displayTitle(key: string): { category: string; name: string } {
  const translated = settingTitleName(key, '');
  return translated ? { category: '', name: translated } : settingTitle(key);
}
