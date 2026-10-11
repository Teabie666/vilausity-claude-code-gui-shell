// Builds every process bundle into dist/ with esbuild.
//   node scripts/build.mjs              development build (source maps)
//   node scripts/build.mjs --watch      rebuild on change
//   node scripts/build.mjs --production no source maps, minified
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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
  legalComments: 'none',
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
}

if (!watch) {
  rmSync(dist, { recursive: true, force: true });
}
copyStatic();

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context({ ...common, ...options })));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('watching for changes (static files are copied once; restart to pick up HTML/CSS/theme edits)');
} else {
  await Promise.all(builds.map((options) => esbuild.build({ ...common, ...options })));
}
