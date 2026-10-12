// Merges translations into the extension UI table (M3.5):
//
//   node tools/extension-strings/merge.mjs <translations.json>
//
// The input maps keys (as `npm run nls -- --todo-extension` prints them) to translations;
// `{0}` stands for a template's variable. A translation equal to the English means "keep it
// English" and is stored as "" so the table never holds English. The local text list of the
// table's extension version (tools/extension-strings/extract.mjs) says which keys are texts
// and which are templates, and entries it no longer lists are dropped.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const tableFile = path.join(root, 'src', 'nls', 'zh-cn.extension.json');
const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/extension-strings/merge.mjs <translations.json>');
  process.exit(2);
}

const table = JSON.parse(readFileSync(tableFile, 'utf8'));
const listFile = path.join(root, '.local', 'extension-strings', `${process.argv[3] ?? table.extensionVersion}.json`);
const list = JSON.parse(readFileSync(listFile, 'utf8'));
const translations = JSON.parse(readFileSync(path.resolve(input), 'utf8'));

const strings = { ...table.strings };
const templates = { ...table.templates };
const problems = [];
let merged = 0;
for (const [key, value] of Object.entries(translations)) {
  if (typeof value !== 'string') {
    problems.push(`${key}: not a string`);
    continue;
  }
  const text = value.trim();
  if (list.strings[key]) {
    strings[key] = text === list.strings[key].text ? '' : text;
    merged++;
  } else if (list.templates[key]) {
    const english = list.templates[key];
    if (text !== english.text && text.split('{0}').length !== 2) {
      problems.push(`${key} (${english.text}): the translation needs {0} once: ${text}`);
      continue;
    }
    templates[key] = { type: english.type, text: text === english.text ? '' : text };
    merged++;
  } else {
    problems.push(`${key}: not in ${path.relative(root, listFile)}`);
  }
}

const keep = (entries, listed) =>
  Object.fromEntries(
    Object.entries(entries)
      .filter(([key]) => key in listed)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
const next = {
  extensionVersion: list.extensionVersion,
  strings: keep(strings, list.strings),
  templates: keep(templates, list.templates),
};
const dropped =
  Object.keys(strings).length - Object.keys(next.strings).length + Object.keys(templates).length - Object.keys(next.templates).length;
writeFileSync(tableFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
console.log(`merged ${merged} translations; dropped ${dropped} entries the ${list.extensionVersion} list no longer has`);
for (const problem of problems) console.log(`  skipped  ${problem}`);
process.exit(problems.length > 0 ? 1 : 0);
