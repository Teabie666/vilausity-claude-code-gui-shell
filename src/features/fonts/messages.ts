/** Text of the font settings. */

import { defineMessages } from '../../platform/nls';

export const t = defineMessages('fonts', {
  uiFontFamily:
    "The font of the user interface: the title bar, tabs, menus and settings, and the Claude Code views' buttons, menus and session list.",
  uiFontSize: 'The font size of the user interface, in pixels.',
  chatFontFamily:
    "The font of the conversation: your messages, Claude's replies and the message input. By default Chinese text is in Noto Sans SC (Source Han Sans), which comes with Vilausity.",
  chatFontSize: 'The font size of the conversation, in pixels.',
  chatCodeFontFamily:
    'The font of code in the conversation: code blocks, inline code, file names and tool output. default: the editor font.',
  chatCodeFontSize: 'The font size of code in the conversation, in pixels.',
  markdownFontFamily: "The font of Markdown previews. Empty: the conversation's font.",
  markdownFontSize: 'The font size of Markdown previews, in pixels.',
  markdownLineHeight: 'The line height of Markdown previews, as a multiple of the font size.',
});
