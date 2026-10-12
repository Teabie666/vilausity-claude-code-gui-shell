import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ExtensionTranslator, normalizeText, templateKey, textKey, translateExtensionUi } from '../../../src/platform/extensionStrings';
import type { ExtensionTranslations, TemplateTranslation } from '../../../src/platform/protocol';
import zhCnTable from '../../../src/nls/zh-cn.extension.json';

/** A table built from English, the way the tools build it (only keys reach the table). */
function table(strings: Record<string, string>, templates: Record<string, TemplateTranslation> = {}): ExtensionTranslations {
  return {
    extensionVersion: '0.0.0',
    strings: Object.fromEntries(Object.entries(strings).map(([english, text]) => [textKey(normalizeText(english)), text])),
    templates: Object.fromEntries(
      Object.entries(templates).map(([english, translation]) => {
        const [prefix, suffix] = english.split('{0}') as [string, string];
        return [templateKey(prefix, suffix), translation];
      }),
    ),
  };
}

describe('normalizeText and keys', () => {
  test('whitespace runs become single spaces and the ends are trimmed', () => {
    assert.equal(normalizeText('  New\n\t session  '), 'New session');
  });

  test('a text key is its length and a hash; equal texts share it, others do not', () => {
    const key = textKey('New session');
    assert.match(key, /^11:[0-9a-z]+$/);
    assert.equal(textKey('New session'), key);
    assert.notEqual(textKey('New sessions'), key);
    assert.notEqual(textKey('new session'), key);
  });

  test('a template key holds both lengths, and the text either side of the variable matters', () => {
    assert.match(templateKey('Rate ', ' stars'), /^5:6:[0-9a-z]+$/);
    assert.notEqual(templateKey('Rate ', ' stars'), templateKey('Rate', '  stars'));
    assert.notEqual(templateKey('', ' days ago'), templateKey(' days ago', ''));
  });
});

describe('ExtensionTranslator', () => {
  test('replaces an exact text and keeps the whitespace around it', () => {
    const translator = new ExtensionTranslator(table({ 'New session': '新建会话' }));
    assert.equal(translator.translate('New session'), '新建会话');
    assert.equal(translator.translate('  New session '), '  新建会话 ');
    assert.equal(translator.translate('New\n   session'), '新建会话');
  });

  test('leaves texts the table lacks, texts it keeps English, and empty texts', () => {
    const translator = new ExtensionTranslator(table({ 'New session': '新建会话', 'Claude Code': '' }));
    assert.equal(translator.translate('New session!'), undefined);
    assert.equal(translator.translate('Claude Code'), undefined);
    assert.equal(translator.translate('   '), undefined);
    assert.equal(translator.translate('x'.repeat(5000)), undefined);
  });

  test('a number template matches digits only', () => {
    const translator = new ExtensionTranslator(table({}, { '{0} days ago': { type: 'number', text: '{0} 天前' } }));
    assert.equal(translator.translate('3 days ago'), '3 天前');
    assert.equal(translator.translate('1,024 days ago'), '1,024 天前');
    assert.equal(translator.translate('a few days ago'), undefined);
    assert.equal(translator.translate(' days ago'), undefined);
  });

  test('an any template takes a variable of any text, with text before and after it', () => {
    const translator = new ExtensionTranslator(
      table({}, { 'Couldn’t switch to {0}, try again.': { type: 'any', text: '无法切换到 {0}，请重试。' } }),
    );
    assert.equal(translator.translate('Couldn’t switch to main, try again.'), '无法切换到 main，请重试。');
    assert.equal(translator.translate(`Couldn’t switch to ${'b'.repeat(101)}, try again.`), undefined);
  });

  test('the variable is translated too when it is a text of the table', () => {
    const translator = new ExtensionTranslator(
      table(
        { 'Claude will ask before each edit': 'Claude 会在每次编辑前询问' },
        { '{0}. Click to change.': { type: 'any', text: '{0}。点击可更改。' } },
      ),
    );
    assert.equal(translator.translate('Claude will ask before each edit. Click to change.'), 'Claude 会在每次编辑前询问。点击可更改。');
    assert.equal(translator.translate('Something else. Click to change.'), 'Something else。点击可更改。');
  });

  test('the template with more text around the variable wins', () => {
    const translator = new ExtensionTranslator(
      table(
        {},
        {
          '{0} ago': { type: 'any', text: '{0}之前' },
          '{0} days ago': { type: 'number', text: '{0} 天前' },
        },
      ),
    );
    assert.equal(translator.translate('3 days ago'), '3 天前');
    assert.equal(translator.translate('a while ago'), 'a while之前');
  });

  test('an exact text is preferred over a template, and an empty template translation keeps English', () => {
    const translator = new ExtensionTranslator(
      table({ '1 day ago': '昨天' }, { '{0} day ago': { type: 'number', text: '{0} 天前' }, 'wait {0}ms': { type: 'number', text: '' } }),
    );
    assert.equal(translator.translate('1 day ago'), '昨天');
    assert.equal(translator.translate('2 day ago'), '2 天前');
    assert.equal(translator.translate('wait 30ms'), undefined);
  });
});

describe('translateExtensionUi', () => {
  test('is on unless the setting is false', () => {
    assert.equal(translateExtensionUi({}), true);
    assert.equal(translateExtensionUi({ 'vilaus.translateExtensionUi': true }), true);
    assert.equal(translateExtensionUi({ 'vilaus.translateExtensionUi': 'no' }), true);
    assert.equal(translateExtensionUi({ 'vilaus.translateExtensionUi': false }), false);
  });
});

describe('the zh-cn extension UI table', () => {
  const zhCn = zhCnTable as ExtensionTranslations;

  test('has a version and well-formed keys', () => {
    assert.match(zhCn.extensionVersion, /^\d+\.\d+\.\d+$/);
    for (const key of Object.keys(zhCn.strings)) assert.match(key, /^\d+:[0-9a-z]+$/, key);
    for (const key of Object.keys(zhCn.templates)) assert.match(key, /^\d+:\d+:[0-9a-z]+$/, key);
  });

  test('every template translation is empty or has {0} once, with a known type', () => {
    for (const [key, template] of Object.entries(zhCn.templates)) {
      assert.ok(template.type === 'number' || template.type === 'any', key);
      assert.ok(template.text === '' || template.text.split('{0}').length === 2, `${key}: ${template.text}`);
    }
  });

  test('builds a translator', () => {
    // The extension's English stays out of the repository: no text to look up here.
    assert.ok(Object.keys(zhCn.strings).length > 1000);
    assert.equal(new ExtensionTranslator(zhCn).translate('not a text of the extension'), undefined);
  });
});
