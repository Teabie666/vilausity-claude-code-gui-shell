// Captures VS Code's built-in themes as vilaus theme files (resources/themes/<id>.json).
//   node tools/theme-capture/run.mjs [--vscodium "C:\Program Files\VSCodium\VSCodium.exe"]
//
// Opens one VSCodium window on a temp folder with the capture extension loaded. The theme
// is switched in that folder's workspace settings only; the user's settings are untouched.
// Font variables are dropped: fonts are vilaus settings, not part of a theme.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const here = import.meta.dirname;
const root = path.resolve(here, '../..');
const runDir = path.join(here, '.run');
const workspace = path.join(runDir, 'workspace');
const outFile = path.join(runDir, 'captured.json');
const extensionDir = path.join(here, 'extension');
const themesDir = path.join(root, 'resources', 'themes');

const THEMES = [
  { id: 'dark-modern', settingsId: 'Default Dark Modern', label: 'Dark Modern' },
  { id: 'light-modern', settingsId: 'Default Light Modern', label: 'Light Modern' },
  { id: 'dark-plus', settingsId: 'Default Dark+', label: 'Dark+' },
  { id: 'light-plus', settingsId: 'Default Light+', label: 'Light+' },
  { id: 'hc-dark', settingsId: 'Default High Contrast', label: 'High Contrast Dark' },
  { id: 'hc-light', settingsId: 'Default High Contrast Light', label: 'High Contrast Light' },
];
const FONT_VARIABLE = /^vscode-(editor-)?font-(family|size|weight)$/;
const TIMEOUT_MS = 120_000;

const { values } = parseArgs({ options: { vscodium: { type: 'string' } } });
const vscodium = values.vscodium ?? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'VSCodium', 'VSCodium.exe');
if (!existsSync(vscodium)) {
  console.error(`VSCodium not found at ${vscodium}; pass --vscodium <path to VSCodium.exe>`);
  process.exit(1);
}

rmSync(runDir, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(path.join(extensionDir, 'capture-config.json'), JSON.stringify({ workspace, out: outFile, themes: THEMES }, null, 2), 'utf8');

// A VS Code-family parent leaks ELECTRON_RUN_AS_NODE / VSCODE_* (VSCODE_PORTABLE included).
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE' || name.toUpperCase().startsWith('VSCODE_')) {
    delete env[name];
  }
}

console.log(`opening a capture window in ${vscodium} ...`);
spawn(
  vscodium,
  [workspace, '--new-window', '--disable-extensions', '--disable-workspace-trust', `--extensionDevelopmentPath=${extensionDir}`],
  { env, detached: true, stdio: 'ignore' },
).unref();

const started = Date.now();
while (!existsSync(outFile) && !existsSync(`${outFile}.error.txt`)) {
  if (Date.now() - started > TIMEOUT_MS) {
    console.error('timed out waiting for the capture window');
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (existsSync(`${outFile}.error.txt`)) {
  console.error(readFileSync(`${outFile}.error.txt`, 'utf8'));
  process.exit(1);
}
// The file may still be flushing.
await new Promise((resolve) => setTimeout(resolve, 300));

const captured = JSON.parse(readFileSync(outFile, 'utf8'));
mkdirSync(themesDir, { recursive: true });
for (const theme of captured.themes) {
  const variables = Object.fromEntries(
    Object.entries(theme.variables)
      .filter(([name]) => name.startsWith('vscode-') && !FONT_VARIABLE.test(name))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const file = path.join(themesDir, `${theme.id}.json`);
  const data = {
    id: theme.id,
    label: theme.label,
    kind: theme.kind,
    source: `${captured.appName} ${captured.vscodeVersion}, "${theme.settingsId}", captured ${captured.capturedAt}`,
    variables,
  };
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`${theme.id}: ${theme.kind}, ${Object.keys(variables).length} variables -> ${path.relative(root, file)}`);
}
if (captured.themes[0]?.defaultStyles) {
  writeFileSync(path.join(runDir, 'defaultStyles.css'), captured.themes[0].defaultStyles, 'utf8');
}
rmSync(path.join(extensionDir, 'capture-config.json'), { force: true });
console.log('done');
