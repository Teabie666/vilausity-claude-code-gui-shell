import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { FONT_SETTING_KEYS, withFontVariables } from '../../../src/host/main/themes';
import { DEFAULT_FONTS } from '../../../src/platform/defaults';
import type { ThemeData } from '../../../src/platform/protocol';
import { fontSettingDefinitions } from '../../../src/features/fonts';
import { editorSettingDefinitions } from '../../../src/features/editor/editorSettings';

const theme: ThemeData = { id: 't', label: 'T', kind: 'vscode-dark', variables: { 'vscode-foreground': '#ccc' } };

describe('withFontVariables', () => {
  test('without settings: the UI in YaHei UI, the conversation in Noto Sans SC, code in the editor font', () => {
    const vars = withFontVariables(theme, {}).variables;
    assert.equal(vars['vscode-foreground'], '#ccc');
    assert.equal(vars['vscode-font-family'], DEFAULT_FONTS.family);
    assert.match(vars['vscode-font-family']!, /Microsoft YaHei UI/);
    assert.equal(vars['vscode-font-size'], '13px');
    assert.match(vars['vilaus-chat-font-family']!, /"Segoe UI", "Noto Sans SC"/);
    assert.equal(vars['vilaus-chat-font-size'], '14px');
    assert.equal(vars['vilaus-chat-code-font-family'], DEFAULT_FONTS.editorFamily);
    assert.equal(vars['vilaus-chat-code-font-size'], '13px');
    assert.equal(vars['vscode-markdown-font-family'], vars['vilaus-chat-font-family']);
    assert.equal(vars['vscode-markdown-line-height'], '1.6');
  });

  test('settings win; "default" and empty families fall back', () => {
    const vars = withFontVariables(theme, {
      'workbench.fontSize': 14,
      'chat.fontFamily': 'default',
      'chat.fontSize': 15.5,
      'chat.editor.fontFamily': 'default',
      'editor.fontFamily': "'Source Code Pro', monospace",
      'markdown.preview.fontFamily': '  ',
      'markdown.preview.lineHeight': 1.8,
    }).variables;
    assert.equal(vars['vscode-font-size'], '14px');
    assert.equal(vars['vilaus-chat-font-family'], DEFAULT_FONTS.chatFamily);
    assert.equal(vars['vilaus-chat-font-size'], '15.5px');
    // Code in the conversation follows the editor font unless set.
    assert.equal(vars['vilaus-chat-code-font-family'], "'Source Code Pro', monospace");
    assert.equal(vars['vscode-editor-font-family'], "'Source Code Pro', monospace");
    assert.equal(vars['vscode-markdown-font-family'], DEFAULT_FONTS.chatFamily);
    assert.equal(vars['vscode-markdown-line-height'], '1.8');
  });

  test('a code font of its own, and nonsense sizes fall back', () => {
    const vars = withFontVariables(theme, { 'chat.editor.fontFamily': 'Consolas', 'chat.editor.fontSize': -3, 'chat.fontSize': '16' }).variables;
    assert.equal(vars['vilaus-chat-code-font-family'], 'Consolas');
    assert.equal(vars['vilaus-chat-code-font-size'], '13px');
    assert.equal(vars['vilaus-chat-font-size'], '14px');
  });

  test('every font setting the settings editor lists changes the theme data, and only those', () => {
    const listed = [...fontSettingDefinitions(), ...editorSettingDefinitions()]
      .map((definition) => definition.key)
      .filter((key) => /font(Family|Size|Weight)$|lineHeight$/.test(key) && !key.startsWith('diffEditor.') && key !== 'editor.lineHeight');
    assert.deepEqual([...listed].sort(), [...FONT_SETTING_KEYS].sort());
  });
});
