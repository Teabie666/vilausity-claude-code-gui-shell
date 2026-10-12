// Lists the Claude Code extension's UI texts for the translation table (M3.5), locally only:
//
//   node tools/extension-strings/extract.mjs [extension dir]
//
// Reads the extension's webview bundle (chat panel, session list) and extension.js (the plan
// preview page, notifications, input boxes and quick picks) and writes
// .local/extension-strings/<version>.json: each text with its key, as the shell computes it
// at run time (src/platform/extensionStrings.ts), and where it was found. That file holds the
// extension's English and never goes into the repository; the table in src/nls only has keys
// and translations. Without an argument the extension is found the way the app finds it.
//
// What counts as UI text is a heuristic over the minified code (see scan.mjs): literals that
// are the value of a property the UI shows (children, title, placeholder, label...), pieces
// of a sentence in a JSX children array, and sentence-like literals elsewhere in the webview
// (`return "Ask Claude to edit…"`). Monaco's own texts (the webview bundles Monaco) are
// subtracted using the monaco-editor package in node_modules. aria-label texts are skipped:
// the shell does not translate them.
import * as esbuild from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanLiterals } from './scan.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

async function importTs(source) {
  const bundle = await esbuild.build({
    stdin: { contents: source, resolveDir: root, loader: 'ts', sourcefile: 'extract-imports.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'warning',
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}

const { normalizeText, textKey, templateKey, locateClaudeExtension } = await importTs(
  "export { normalizeText, textKey, templateKey } from './src/platform/extensionStrings';\n" +
    "export { locateClaudeExtension } from './src/host/main/extensionLocator';",
);

const explicitDir = process.argv[2];
const extension = locateClaudeExtension(explicitDir);
if (!extension) {
  console.error(explicitDir ? `no Claude Code extension in ${explicitDir}` : 'Claude Code extension not found');
  process.exit(1);
}

/** Longer texts are descriptions, not the UI's skeleton; they stay English. */
const MAX_LENGTH = 100;
/** Properties whose value the UI shows as text. */
const TEXT_PROPERTIES = new Set([
  'children', 'title', 'placeholder', 'data-placeholder', 'label', 'description', 'tooltip', 'closeTooltip',
  'confirmLabel', 'cancelLabel', 'emptyText', 'emptyMessage', 'message', 'text', 'header', 'heading', 'subtitle',
  'detail', 'caption', 'hint', 'buttonText', 'actionLabel', 'submitLabel', 'primaryLabel', 'secondaryLabel',
  // vscode.window.showInputBox / showQuickPick options
  'placeHolder', 'prompt', 'validationMessage',
  // the extension's icon buttons show their ariaLabel as the tooltip too
  'ariaLabel',
]);
/** Properties of the DOM's aria attributes, which the shell leaves alone. */
const ARIA_PROPERTIES = new Set(['aria-label', 'aria-description']);
/** Calls in extension.js whose texts the shell shows. */
const UI_CALLS = new Set([
  'showInformationMessage', 'showWarningMessage', 'showErrorMessage', 'showQuickPick', 'showInputBox', 'createQuickPick',
  'createInputBox', 'withProgress',
]);
/** Calls whose texts are logs or internal errors. */
const LOG_CALLS = new Set(['log', 'warn', 'error', 'info', 'debug', 'trace', 'Error', 'TypeError', 'RangeError', 'logEvent', 'logError']);

const CSS_MODULE_CLASS = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]{6}$/;
const CODE = /[{}<>\\]|=>|&&|\|\||==|\$\{|^\s*[.#/@-]|:\/\/|^(https?|file|vscode|data|mailto):/;

/** A text a person reads (a label, a button, a short sentence) rather than code or data. */
function looksLikeText(text, strict) {
  if (text.length < 2 || text.length > MAX_LENGTH || !/[A-Za-z]{2}/.test(text)) return false;
  if (CSS_MODULE_CLASS.test(text) || CODE.test(text)) return false;
  if (!text.includes(' ')) {
    if (/[/\\]/.test(text)) return false; // a path
    // One word: Capitalized ("Stop", "Retrying…") or a short abbreviation ("OK", "IN").
    if (!/^[A-Z][a-z]+(?:['-][a-z]+)*[.…!?:]?$/.test(text) && !/^[A-Z]{2,5}$/.test(text)) return false;
  }
  if (!strict) return true;
  // Elsewhere in the code: a phrase starting with a capital, mostly letters, not a log prefix.
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  return /^[A-Z]/.test(text) && text.includes(' ') && letters / text.length >= 0.6 && !/[:(%]$/.test(text) && !/%[sdo]/.test(text);
}

/** A template as text, `{0}` for each variable: how templates are compared with Monaco's. */
const templateText = (parts) => normalizeText(parts.join('{0}'));

/**
 * Every literal in the monaco-editor package's source. The webview bundles an older Monaco
 * whose localize() calls are recognized by their shape (localizeLike); its other texts
 * (errors, command descriptions) are mostly the same as in this version.
 */
function monacoLiterals() {
  const texts = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith('.js')) {
        scanLiterals(readFileSync(full, 'utf8'), (literal) => {
          texts.add(literal.kind === 'string' ? normalizeText(literal.value) : templateText(literal.parts));
        });
      }
    }
  };
  const esm = path.join(root, 'node_modules', 'monaco-editor', 'esm', 'vs');
  if (existsSync(esm)) walk(esm);
  return texts;
}

const monaco = monacoLiterals();
const strings = new Map();
const templates = new Map();
const stats = { tooLong: 0, monaco: 0, manyVariables: 0 };

/**
 * Whether a text is Monaco's. Found in Monaco's code it is, unless it is a short label the
 * extension shows itself ("Cancel", "Copy to clipboard"): those count when React shows them.
 */
function isMonaco(text, kind) {
  const words = text.split(' ').length;
  return monaco.has(text) && (kind === 'code' || words >= 4);
}

/** `elements`: the children array the text is in, complete only once the scan is done. */
function addString(raw, kind, source, elements) {
  const text = normalizeText(raw);
  if (isMonaco(text, kind)) {
    stats.monaco++;
    return;
  }
  const key = textKey(text);
  const entry = strings.get(key) ?? { text, kinds: new Set(), sources: new Set(), arrays: new Set() };
  entry.kinds.add(kind);
  entry.sources.add(source);
  if (elements) entry.arrays.add(elements);
  strings.set(key, entry);
}

function addTemplate(parts, kind, source) {
  // A marker that survives normalization splits the normalized template again.
  const [prefix, suffix] = normalizeText(`${parts[0]}\u0001${parts[1]}`).split('\u0001');
  const words = `${prefix} ${suffix}`.trim();
  if (isMonaco(templateText(parts), kind)) {
    stats.monaco++;
    return;
  }
  // The variable must stand apart: `lvl-${n}` or `${n}px` is code, not a sentence; a text that
  // starts with punctuation is a log line or CSS. A time unit after a number is text: `in ${n}h`.
  const unit = /^(?:ms|[smhd])$/.test(suffix) && /(?:^|\s)$/.test(prefix);
  if (/[\w-]$/.test(prefix) || (/^[\w]/.test(suffix) && !unit) || (prefix && !/^[A-Za-z]/.test(prefix))) return;
  if (unit) {
    const key = templateKey(prefix, suffix);
    const entry = templates.get(key) ?? { text: `${prefix}{0}${suffix}`, type: 'number', kinds: new Set(), sources: new Set() };
    entry.kinds.add(kind);
    entry.sources.add(source);
    templates.set(key, entry);
    return;
  }
  // `${description}. Click to change…`: the text after a leading variable starts with punctuation.
  const text = words.replace(/^[\s.,;:!?·—-]+/, '');
  if (/\d+px\b|\brgba?\(|\bvar\(--/.test(words) || !looksLikeText(text, kind === 'code') || !words.includes(' ')) return;
  const key = templateKey(prefix, suffix);
  const letters = (words.match(/[A-Za-z]/g) ?? []).length;
  const entry = templates.get(key) ?? {
    text: `${prefix}{0}${suffix}`,
    // A short text around the variable could match other texts: then the variable must be a number.
    type: letters >= 12 ? 'any' : 'number',
    kinds: new Set(),
    sources: new Set(),
  };
  entry.kinds.add(kind);
  entry.sources.add(source);
  templates.set(key, entry);
}

/** The sentence a children array renders, its other elements shown as {…}. */
function sentenceOf(elements) {
  if (!elements || elements.length < 2) return undefined;
  return normalizeText(elements.map((element) => (element === null ? ' {…} ' : element)).join(''));
}

function kindOf(context) {
  if (context.children) return 'children';
  if (context.property && TEXT_PROPERTIES.has(context.property)) return context.property;
  if (context.property && ARIA_PROPERTIES.has(context.property)) return 'aria';
  return 'code';
}

function collectWebview(file) {
  scanLiterals(readFileSync(file, 'utf8'), (literal) => {
    const kind = kindOf(literal.context);
    const { localizeLike, calls, properties } = literal.context;
    // `comment` holds the notes for translators in Monaco's localize keys.
    if (kind === 'aria' || localizeLike || calls.some((call) => LOG_CALLS.has(call)) || properties.includes('comment')) return;
    const strict = kind === 'code';
    if (literal.kind === 'template' && literal.parts.length > 1) {
      if (literal.parts.length > 2) stats.manyVariables++;
      else addTemplate(literal.parts, kind, 'webview');
      return;
    }
    const value = literal.kind === 'string' ? literal.value : literal.parts[0];
    const text = normalizeText(value);
    if (text.length > MAX_LENGTH && looksLikeText(text.slice(0, MAX_LENGTH), strict)) stats.tooLong++;
    if (looksLikeText(text, strict)) {
      addString(text, kind, 'webview', literal.context.elements);
    } else if (strict && /^[A-Z][a-z]{1,15}[.…!?]?$/.test(text) && ['=', 'return', '?', ':'].includes(literal.context.after)) {
      // A one-word label chosen in code: `let label = "Yes"; if (...) label = "Yes, and auto-accept"`.
      // Monaco has many such words too; a label is kept anyway ("No" must not be Monaco's alone).
      addString(text, 'value', 'webview');
    } else if (literal.context.children && looksLikePiece(text)) {
      // " command?" alone is no label, but it is part of a sentence: decided once the array is complete.
      pieces.push({ text, elements: literal.context.elements });
    }
  });
  for (const piece of pieces.splice(0)) {
    // An element of its own (not `x === "dirty" ? ... : ...` inside one) among others.
    const alone = piece.elements.some((element) => element !== null && normalizeText(element) === piece.text);
    if (alone && piece.elements.length >= 2) addString(piece.text, 'children', 'webview', piece.elements);
  }
}

/** Candidates for a piece of a sentence (" command?", " for "), kept when their array has more elements. */
const pieces = [];
function looksLikePiece(text) {
  const camelCase = /^[a-z]+[A-Z]\w*$/;
  return text.length <= MAX_LENGTH && /[A-Za-z]{2}/.test(text) && !CSS_MODULE_CLASS.test(text) && !CODE.test(text) && !camelCase.test(text);
}

/** Text between tags and the placeholder / title attributes of an HTML page in a literal. */
function collectHtml(html, source) {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  for (const match of body.matchAll(/>([^<>]+)</g)) {
    const text = normalizeText(match[1]);
    if (looksLikeText(text, false)) addString(text, 'html', source);
  }
  for (const match of body.matchAll(/\s(?:placeholder|title)="([^"]+)"/g)) {
    const text = normalizeText(match[1]);
    if (looksLikeText(text, false)) addString(text, 'html', source);
  }
}

function collectExtension(file) {
  scanLiterals(readFileSync(file, 'utf8'), (literal) => {
    const html = literal.kind === 'string' ? literal.value : literal.parts.join('');
    if (/<body[\s>]/.test(html)) {
      collectHtml(html, 'extension');
      return;
    }
    const call = [...literal.context.calls].reverse().find((name) => UI_CALLS.has(name));
    if (!call || literal.context.calls.some((name) => LOG_CALLS.has(name))) return;
    const kind = kindOf(literal.context);
    if (kind === 'aria') return;
    if (literal.kind === 'template' && literal.parts.length > 1) {
      if (literal.parts.length > 2) stats.manyVariables++;
      else addTemplate(literal.parts, call, 'extension');
      return;
    }
    const text = normalizeText(literal.kind === 'string' ? literal.value : literal.parts[0]);
    if (looksLikeText(text, kind === 'code')) addString(text, call, 'extension');
  });
}

/**
 * The descriptions of the extension's settings (`contributes.configuration`), which the
 * settings editor shows: translated by the extension host before they reach it.
 */
function collectSettings(packageJson) {
  const configuration = packageJson.contributes?.configuration;
  for (const group of Array.isArray(configuration) ? configuration : [configuration]) {
    for (const schema of Object.values(group?.properties ?? {})) {
      const texts = [
        schema.description,
        schema.markdownDescription,
        schema.deprecationMessage,
        schema.markdownDeprecationMessage,
        ...(schema.enumDescriptions ?? []),
        ...(schema.markdownEnumDescriptions ?? []),
        ...(schema.enumItemLabels ?? []),
      ];
      for (const value of texts) {
        const text = typeof value === 'string' ? normalizeText(value) : '';
        if (text) addString(text, 'setting', 'manifest');
      }
    }
  }
}

const packageJson = JSON.parse(readFileSync(path.join(extension.path, 'package.json'), 'utf8'));
collectWebview(path.join(extension.path, 'webview', 'index.js'));
collectExtension(path.join(extension.path, String(packageJson.main ?? 'extension.js')));
collectSettings(packageJson);

/** UTF-16 code unit order, the default sort's for strings. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (map) =>
  Object.fromEntries(
    [...map.entries()]
      .sort(([, a], [, b]) => byCodeUnit(a.text, b.text))
      .map(([key, { arrays, ...entry }]) => {
        const sentences = [...(arrays ?? [])].map(sentenceOf).filter((sentence) => sentence && sentence !== entry.text);
        return [
          key,
          {
            ...entry,
            kinds: [...entry.kinds].sort(byCodeUnit),
            sources: [...entry.sources].sort(byCodeUnit),
            ...(sentences.length > 0 ? { sentences: [...new Set(sentences)].sort(byCodeUnit) } : {}),
          },
        ];
      }),
  );
const output = {
  extensionVersion: extension.version,
  extensionPath: extension.path,
  strings: sorted(strings),
  templates: sorted(templates),
};
const outDir = path.join(root, '.local', 'extension-strings');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${extension.version}.json`);
writeFileSync(outFile, `${JSON.stringify(output, null, 1)}\n`, 'utf8');

const sentencePieces = Object.values(output.strings).filter((entry) => entry.sentences).length;
console.log(
  `Claude Code ${extension.version}: ${strings.size} texts (${sentencePieces} of them pieces of sentences), ` +
    `${templates.size} templates with one variable -> ${path.relative(root, outFile)}`,
);
console.log(
  `skipped: ${stats.monaco} Monaco texts, ${stats.tooLong} longer than ${MAX_LENGTH} characters, ` +
    `${stats.manyVariables} templates with several variables`,
);
