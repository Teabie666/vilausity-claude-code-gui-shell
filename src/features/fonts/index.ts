/**
 * The font settings, in one section of the settings editor: the UI, the conversation, the code
 * in it and Markdown previews (the editor's own fonts are the editor module's, in the same
 * section). Nothing here applies them: main turns them into the theme's font variables
 * (host/main/themes.ts), which the shell and every webview read.
 */

import type { SettingDefinition } from '../../core/settings';
import type { ShellModule } from '../../core/module';
import { SettingsSection } from '../../core/messages';
import { ISettings } from '../../core/serviceIds';
import { DEFAULT_FONT_VALUE, DEFAULT_FONTS } from '../../platform/defaults';
import { t } from './messages';

/** Orders in the section; the editor's fonts come between the conversation's and Markdown's (20-22). */
const ORDER = { ui: 0, chat: 10, markdown: 30 } as const;

export function fontSettingDefinitions(): SettingDefinition[] {
  const section = SettingsSection.fonts;
  const size = (description: string, fallback: number) => ({ type: 'number', default: fallback, minimum: 6, maximum: 100, description });
  return [
    {
      key: 'workbench.fontFamily',
      section,
      order: ORDER.ui,
      showDescription: true,
      schema: { type: 'string', default: DEFAULT_FONTS.family, description: t('uiFontFamily') },
    },
    { key: 'workbench.fontSize', section, order: ORDER.ui + 1, schema: { ...size(t('uiFontSize'), DEFAULT_FONTS.size), maximum: 32 } },
    {
      key: 'chat.fontFamily',
      section,
      order: ORDER.chat,
      showDescription: true,
      schema: { type: 'string', default: DEFAULT_FONTS.chatFamily, description: t('chatFontFamily') },
    },
    { key: 'chat.fontSize', section, order: ORDER.chat + 1, schema: size(t('chatFontSize'), DEFAULT_FONTS.chatSize) },
    {
      key: 'chat.editor.fontFamily',
      section,
      order: ORDER.chat + 2,
      showDescription: true,
      schema: { type: 'string', default: DEFAULT_FONT_VALUE, description: t('chatCodeFontFamily') },
    },
    { key: 'chat.editor.fontSize', section, order: ORDER.chat + 3, schema: size(t('chatCodeFontSize'), DEFAULT_FONTS.chatCodeSize) },
    {
      key: 'markdown.preview.fontFamily',
      section,
      order: ORDER.markdown,
      showDescription: true,
      schema: { type: 'string', default: '', description: t('markdownFontFamily') },
    },
    {
      key: 'markdown.preview.fontSize',
      section,
      order: ORDER.markdown + 1,
      schema: size(t('markdownFontSize'), DEFAULT_FONTS.markdownSize),
    },
    {
      key: 'markdown.preview.lineHeight',
      section,
      order: ORDER.markdown + 2,
      schema: { type: 'number', default: DEFAULT_FONTS.markdownLineHeight, minimum: 1, maximum: 4, description: t('markdownLineHeight') },
    },
  ];
}

export const fontsModule: ShellModule = {
  id: 'fonts',
  activate({ services, subscriptions }) {
    subscriptions.add(services.get(ISettings).register(fontSettingDefinitions()));
  },
};
