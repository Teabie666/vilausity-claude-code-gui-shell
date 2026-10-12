import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { SettingsService } from '../../../src/core/settings';
import { colorIdForVariable, toHexColor } from '../../../src/features/editor/colors';
import {
  diffEditorOptions,
  editorOptions,
  mergeOptions,
  monacoOptionDefinitions,
  nestedOptions,
} from '../../../src/features/editor/editorSettings';
import { minimalReplacement } from '../../../src/features/editor/textModels';
import { shortDiffTitle } from '../../../src/features/editor/titles';
import { matchRanges, scorePath } from '../../../src/features/quickOpen/fuzzy';

describe('shortDiffTitle', () => {
  test('replaces a document path with spaces, whatever its case and separators', () => {
    const path = 'c:\\Users\\me\\Made by Claude (Code)\\proj\\a.txt';
    assert.equal(shortDiffTitle('✻ [Claude Code] C:\\Users\\me\\Made by Claude (Code)\\proj\\a.txt', [path]), '✻ [Claude Code] a.txt');
    assert.equal(shortDiffTitle('✻ [Claude Code] /c:/Users/me/Made by Claude (Code)/proj/a.txt', [path]), '✻ [Claude Code] a.txt');
  });

  test('shortens other absolute paths without spaces, keeps plain titles', () => {
    assert.equal(shortDiffTitle('x c:\\a\\b.txt → c:\\a\\c.txt', []), 'x b.txt → c.txt');
    assert.equal(shortDiffTitle('sample.ts (on disk) ↔ sample.ts', ['c:\\w\\sample.ts']), 'sample.ts (on disk) ↔ sample.ts');
  });
});

describe('scorePath', () => {
  test('needs the typed characters in order', () => {
    assert.equal(scorePath('src/features/editor/index.ts', 'xyz'), undefined);
    assert.notEqual(scorePath('src/features/editor/index.ts', 'feidx'), undefined);
  });

  test('a match in the file name beats one spread over folders', () => {
    const inName = scorePath('src/conversationTabs.ts', 'ctab')!;
    const inFolders = scorePath('src/core/tabs/a.ts', 'ctab')!;
    assert.ok(inName > inFolders);
  });

  test('consecutive and word-start characters score more', () => {
    assert.ok(scorePath('lib/textModels.ts', 'tm')! > scorePath('lib/atom.ts', 'tm')!);
    assert.ok(scorePath('a/editor.ts', 'edit')! > scorePath('a/e_d_i_t.ts', 'edit')!);
  });
});

describe('matchRanges', () => {
  test('the typed characters, first places in order, merged into runs', () => {
    assert.deepEqual(matchRanges('a_b_cd.ts', 'ABCD'), [
      [0, 1],
      [2, 3],
      [4, 6],
    ]);
    assert.deepEqual(matchRanges('Alpha.ts', 'al pha'), [[0, 5]]);
    assert.equal(matchRanges('alpha.ts', 'xyz'), undefined);
  });
});

describe('theme colors for Monaco', () => {
  test('toHexColor accepts hex and rgb[a], rejects the rest', () => {
    assert.equal(toHexColor('#ABC'), '#aabbcc');
    assert.equal(toHexColor('#1f1f1f'), '#1f1f1f');
    assert.equal(toHexColor('rgba(255, 0, 0, 0.5)'), '#ff000080');
    assert.equal(toHexColor('rgb(1, 2, 3)'), '#010203');
    assert.equal(toHexColor('rgba(1, 2, 3, 1)'), '#010203');
    assert.equal(toHexColor('13px'), undefined);
    assert.equal(toHexColor('"liga" off'), undefined);
  });

  test('colorIdForVariable turns a CSS variable back into a color id', () => {
    assert.equal(colorIdForVariable('vscode-editor-background'), 'editor.background');
    assert.equal(colorIdForVariable('vscode-editorLineNumber-activeForeground'), 'editorLineNumber.activeForeground');
    assert.equal(colorIdForVariable('editor-background'), undefined);
  });
});

describe('editor settings as Monaco options', () => {
  test('nestedOptions turns dotted keys under a prefix into nested options', () => {
    const values = {
      'editor.rulers': [80],
      'editor.minimap.side': 'left',
      'editor.minimap.scale': 2,
      'diffEditor.wordWrap': 'on',
      'diffEditor.fontSize': 12,
      'workbench.fontSize': 13,
      'editor.__proto__.x': 1,
    };
    assert.deepEqual(nestedOptions(values, 'editor.'), { rulers: [80], minimap: { side: 'left', scale: 2 } });
    assert.deepEqual(nestedOptions(values, 'diffEditor.', { wordWrap: 'diffWordWrap' }, new Set(['fontSize'])), { diffWordWrap: 'on' });
  });

  test('mergeOptions merges nested objects, the second winning', () => {
    assert.deepEqual(mergeOptions({ minimap: { enabled: true }, rulers: [1] }, { minimap: { side: 'left' }, rulers: [2, 3] }), {
      minimap: { enabled: true, side: 'left' },
      rulers: [2, 3],
    });
  });

  const fakeSettings = (values: Record<string, unknown>, declared: string[]): SettingsService =>
    ({
      values,
      get: (key: string, fallback: unknown) => (key in values ? values[key] : fallback),
      definition: (key: string) => (declared.includes(key) ? { key, section: 'S', schema: {} } : undefined),
    }) as unknown as SettingsService;

  test('editorOptions passes on declared settings only; fonts and indentation go another way', () => {
    const settings = fakeSettings(
      { 'editor.rulers': [80], 'editor.minimap.side': 'left', 'editor.readOnly': false, 'editor.fontSize': 20, 'editor.tabSize': 2 },
      ['editor.rulers', 'editor.minimap.side', 'editor.fontSize', 'editor.tabSize'],
    );
    const options = editorOptions(settings);
    assert.deepEqual(options.rulers, [80]);
    assert.deepEqual(options.minimap, { enabled: true, side: 'left' });
    assert.deepEqual(
      ['readOnly', 'fontSize', 'tabSize'].filter((name) => name in options),
      [],
    );
  });

  test("diffEditorOptions uses Monaco's names, and its own font only when set", () => {
    const settings = fakeSettings(
      {
        'diffEditor.wordWrap': 'on',
        'diffEditor.hideUnchangedRegions.enabled': true,
        'diffEditor.fontSize': 0,
        'diffEditor.originalEditable': true,
      },
      ['diffEditor.wordWrap', 'diffEditor.hideUnchangedRegions.enabled', 'diffEditor.fontSize'],
    );
    const options = diffEditorOptions(settings);
    assert.equal(options.diffWordWrap, 'on');
    assert.deepEqual(options.hideUnchangedRegions, { enabled: true });
    assert.deepEqual(
      ['wordWrap', 'fontSize', 'originalEditable'].filter((name) => name in options),
      [],
    );
  });

  test("monacoOptionDefinitions reads Monaco's schemas: one setting, or a map of full keys", () => {
    const options = {
      rulers: { name: 'rulers', schema: { type: 'array', default: [] } },
      minimap: { name: 'minimap', schema: { 'editor.minimap.side': { type: 'string', enum: ['left', 'right'] } } },
      internal: { name: 'internal' },
      fontSize: { name: 'fontSize', schema: { type: 'number' } },
    };
    const definitions = monacoOptionDefinitions(options, 'Text Editor', (key) => key === 'editor.fontSize');
    assert.deepEqual(
      definitions.map((definition) => [definition.key, definition.hidden]),
      [
        ['editor.rulers', true],
        ['editor.minimap.side', true],
      ],
    );
  });
});

describe('minimalReplacement', () => {
  test('keeps the common prefix and suffix', () => {
    assert.deepEqual(minimalReplacement('abcXYZdef', 'abc12def'), { start: 3, end: 6, text: '12' });
    assert.deepEqual(minimalReplacement('same', 'same'), { start: 4, end: 4, text: '' });
    assert.deepEqual(minimalReplacement('log\n', 'log\nmore\n'), { start: 4, end: 4, text: 'more\n' });
  });
});
