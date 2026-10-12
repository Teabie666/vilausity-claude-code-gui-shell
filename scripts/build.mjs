// Builds every process bundle into dist/ with esbuild.
//   node scripts/build.mjs              development build (source maps)
//   node scripts/build.mjs --watch      rebuild on change
//   node scripts/build.mjs --production no source maps, minified (what the installer ships)
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const NODE_TARGET = 'node24';
const CHROME_TARGET = 'chrome152';

const common = {
  absWorkingDir: root,
  bundle: true,
  logLevel: 'info',
  sourcemap: production ? false : 'linked',
  minify: production,
  // Function and class names stay readable in the logs' stack traces, and code that looks at
  // a name (the extension inspecting the API's classes) sees the real one.
  keepNames: production,
  // The licenses go into ThirdPartyNotices.txt instead (writeNotices).
  legalComments: 'none',
  metafile: true,
  external: ['electron', 'vscode'],
  // Prefer ESM entry points: some dependencies (jsonc-parser) ship UMD as `main`, whose
  // internal dynamic requires cannot be bundled.
  mainFields: ['module', 'main'],
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  { entryPoints: ['src/host/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', target: NODE_TARGET },
  // main's worker thread that reads Claude Code's transcripts for the session search.
  {
    entryPoints: ['src/host/main/sessionSearchWorker.ts'],
    outfile: 'dist/sessionSearchWorker.js',
    platform: 'node',
    format: 'cjs',
    target: NODE_TARGET,
  },
  { entryPoints: ['src/host/preload/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', target: NODE_TARGET },
  { entryPoints: ['src/host/exthost/main.ts'], outfile: 'dist/exthost.js', platform: 'node', format: 'cjs', target: NODE_TARGET },
  // ESM with code splitting: Monaco, Shiki grammars and the Markdown renderer sit behind
  // dynamic import() and load on first use, so the shell itself starts small.
  {
    entryPoints: { main: 'src/host/renderer/main.ts' },
    outdir: 'dist/renderer',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    target: CHROME_TARGET,
    // Monaco's modules import their own CSS; the prebuilt stylesheet is copied instead (copyStatic).
    loader: { '.css': 'empty' },
  },
  // Monaco's workers: the editor's (diff computation, word suggestions) and the JSON language
  // service's (settings.json). Self-contained, classic workers.
  {
    entryPoints: {
      'editor.worker': 'monaco-editor/editor/editor.worker.js',
      'json.worker': 'monaco-editor/languages/features/json/json.worker.js',
    },
    outdir: 'dist/renderer',
    platform: 'browser',
    format: 'iife',
    target: CHROME_TARGET,
  },
  // Inlined into every webview document, so no source map comment and no module wrapper.
  {
    entryPoints: ['src/host/webview/bootstrap.ts'],
    outfile: 'dist/webview-bootstrap.js',
    platform: 'browser',
    format: 'iife',
    target: CHROME_TARGET,
    sourcemap: false,
  },
];

function copyStatic() {
  mkdirSync(path.join(dist, 'renderer'), { recursive: true });
  for (const file of ['index.html', 'styles.css']) {
    cpSync(path.join(root, 'src/host/renderer', file), path.join(dist, 'renderer', file));
  }
  // Every Monaco style in one file (codicon font inlined); loaded together with the editor.
  cpSync(path.join(root, 'node_modules/monaco-editor/min/vs/editor/editor.main.css'), path.join(dist, 'renderer', 'monaco.css'));
  const themes = path.join(root, 'resources/themes');
  if (existsSync(themes)) {
    cpSync(themes, path.join(dist, 'themes'), { recursive: true });
  }
  // Drawn by scripts/icons.mjs (npm run icons); the window icon in the taskbar and Alt+Tab.
  cpSync(path.join(root, 'resources/icon/icon.ico'), path.join(dist, 'icon.ico'));
  copyFonts();
}

/**
 * The bundled font: Noto Sans SC (Source Han Sans' glyphs, SIL Open Font License 1.1, its
 * license file goes along), variable weight, in the slices Google Fonts cuts it into so a page
 * loads only the ones its text needs. fonts.css declares it as "Noto Sans SC" with absolute
 * ccw://app URLs (src/platform/webviewUrls.ts), so the shell links it and main inlines it into
 * every webview document.
 */
function copyFonts() {
  const pkg = path.join(root, 'node_modules/@fontsource-variable/noto-sans-sc');
  const out = path.join(dist, 'renderer', 'fonts');
  cpSync(path.join(pkg, 'files'), path.join(out, 'noto-sans-sc'), { recursive: true });
  cpSync(path.join(pkg, 'LICENSE'), path.join(out, 'noto-sans-sc', 'LICENSE'));
  const css = readFileSync(path.join(pkg, 'index.css'), 'utf8')
    .replace(/\/\*[^*]*\*\//g, '')
    .replaceAll("'Noto Sans SC Variable'", "'Noto Sans SC'")
    .replaceAll('url(./files/', 'url(ccw://app/fonts/noto-sans-sc/')
    // A local file: waiting for it beats showing the fallback font first and then moving the text.
    .replaceAll('font-display: swap', 'font-display: block')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!css.includes("font-family: 'Noto Sans SC';") || css.includes('./files/')) {
    throw new Error('unexpected @fontsource-variable/noto-sans-sc stylesheet; check copyFonts()');
  }
  writeFileSync(path.join(out, 'fonts.css'), `${css}\n`, 'utf8');
}

if (!watch) {
  rmSync(dist, { recursive: true, force: true });
}
copyStatic();

/** Packages whose files the build copies rather than bundles (copyStatic). */
const COPIED_PACKAGES = ['monaco-editor', '@fontsource-variable/noto-sans-sc'];

/** LICENSE, LICENSE.md, LICENSE-MPL, COPYING, NOTICE, ThirdPartyNotices.txt... (Apache-2.0 asks for NOTICE too). */
const LICENSE_FILE = /^(licen[cs]e|copying|notice|thirdpartynotices)([-.]\w+)*$/i;

/** `node_modules/@scope/name/lib/x.js` -> `node_modules/@scope/name` (the innermost package). */
function packageDirOf(input) {
  const parts = input.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) {
    return undefined;
  }
  const length = parts[at + 1]?.startsWith('@') ? 3 : 2;
  return parts.slice(0, at + length).join('/');
}

/** package.json's `repository` as a link: `owner/repo` and `github:owner/repo` mean GitHub. */
function repositoryUrl(repository) {
  const value = typeof repository === 'string' ? repository : repository?.url;
  if (!value) {
    return undefined;
  }
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(value);
  return shorthand ? `https://github.com/${shorthand[1]}` : value.replace(/^git\+/, '').replace(/\.git$/, '');
}

/**
 * ThirdPartyNotices.txt: the license of every package whose code the bundles contain (from the
 * metafiles, so nothing is missed or listed for nothing) or whose files the build copies.
 * Bundling drops their license comments; the installer puts this file next to the program.
 */
function writeNotices(results) {
  const dirs = new Set(COPIED_PACKAGES.map((name) => `node_modules/${name}`));
  for (const result of results) {
    for (const input of Object.keys(result.metafile.inputs)) {
      const dir = packageDirOf(input);
      if (dir) {
        dirs.add(dir);
      }
    }
  }
  const packages = [...dirs]
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
      const files = readdirSync(path.join(root, dir))
        .filter((name) => LICENSE_FILE.test(name))
        .sort();
      if (files.length === 0) {
        throw new Error(`${dir} has no license file; add its license to ThirdPartyNotices by hand`);
      }
      const read = (name) =>
        readFileSync(path.join(root, dir, name), 'utf8')
          .replace(/\r\n/g, '\n')
          .trim();
      return {
        title: `${manifest.name} ${manifest.version}, license: ${manifest.license ?? 'see below'}`,
        url: manifest.homepage ?? repositoryUrl(manifest.repository),
        text: files.length === 1 ? read(files[0]) : files.map((name) => `--- ${name}\n\n${read(name)}`).join('\n\n'),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
  const rule = '='.repeat(78);
  const notices = [
    'Vilausity includes the third-party software listed below, under the licenses that follow.',
    'Electron and Chromium come with their own notices: LICENSE.electron.txt and LICENSES.chromium.html.',
    '',
    ...packages.map((entry) => `- ${entry.title}${entry.url ? `  ${entry.url}` : ''}`),
    '',
    ...packages.flatMap((entry) => [rule, entry.title, rule, '', entry.text, '']),
  ].join('\n');
  writeFileSync(path.join(dist, 'ThirdPartyNotices.txt'), notices, 'utf8');
}

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context({ ...common, ...options })));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('watching for changes (static files are copied once; restart to pick up HTML/CSS/theme edits)');
} else {
  const results = await Promise.all(builds.map((options) => esbuild.build({ ...common, ...options })));
  writeNotices(results);
}
