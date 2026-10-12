/**
 * Keys that do something without a shell keybinding, listed with the keybindings so that
 * they can be found, and so that a new keybinding on the same keys warns: main would take the
 * keys before the page, the editor or the conversation sees them. They cannot be changed.
 */

import { t } from './messages';

export interface BuiltinKeybinding {
  readonly title: string;
  /** Normalized chord, see platform/keybindings.ts. */
  readonly key: string;
  /** Where it applies, in words (the When column). */
  readonly where: string;
  readonly source: string;
}

export function builtinKeybindings(): BuiltinKeybinding[] {
  const text = (title: string, key: string): BuiltinKeybinding => ({ title, key, where: t('whereText'), source: t('sourceSystem') });
  const editor = (title: string, key: string): BuiltinKeybinding => ({ title, key, where: t('whereEditor'), source: t('sourceEditor') });
  return [
    text(t('copy'), 'ctrl+c'),
    text(t('cut'), 'ctrl+x'),
    text(t('paste'), 'ctrl+v'),
    text(t('selectAll'), 'ctrl+a'),
    text(t('undo'), 'ctrl+z'),
    text(t('redo'), 'ctrl+y'),
    { title: t('closeWindow'), key: 'alt+f4', where: '', source: t('sourceSystem') },
    { title: t('toggleDevTools'), key: 'f12', where: '', source: t('sourceSystem') },
    { title: t('toggleDevTools'), key: 'ctrl+shift+i', where: '', source: t('sourceSystem') },
    // The conversation page's own (the Claude Code extension's webview).
    { title: t('sendMessage'), key: 'enter', where: t('whereChatInput'), source: t('sourceConversation') },
    { title: t('newLine'), key: 'shift+enter', where: t('whereChatInput'), source: t('sourceConversation') },
    { title: t('closeMenus'), key: 'escape', where: t('whereConversation'), source: t('sourceConversation') },
    // Monaco's, in the content pane's text editor.
    editor(t('addCursorAbove'), 'ctrl+alt+up'),
    editor(t('addCursorBelow'), 'ctrl+alt+down'),
    editor(t('addSelectionToNextMatch'), 'ctrl+d'),
    editor(t('toggleLineComment'), 'ctrl+/'),
    editor(t('moveLineUp'), 'alt+up'),
    editor(t('moveLineDown'), 'alt+down'),
    editor(t('copyLineDown'), 'shift+alt+down'),
    editor(t('deleteLine'), 'ctrl+shift+k'),
    editor(t('goToLine'), 'ctrl+g'),
    editor(t('replace'), 'ctrl+h'),
    editor(t('formatDocument'), 'shift+alt+f'),
    editor(t('triggerSuggest'), 'ctrl+space'),
    editor(t('fold'), 'ctrl+shift+['),
    editor(t('unfold'), 'ctrl+shift+]'),
  ];
}
