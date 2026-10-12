// Installer test: installs release\Vilausity-Setup-<version>.exe silently, checks what it put
// where (files, shortcuts, the uninstall entry, vilaus:// links, File Explorer's menu), starts
// the installed program, uninstalls it silently and checks that only the data stayed.
//   npm run package && node tests/installer.mjs          for the current user, into .test-data
//   node tests/installer.mjs --all-users                 for all users, into Program Files
//                                                         (from an elevated shell)
// Two rounds: File Explorer's entries there before (an earlier install's: they follow the new
// copy and go with it), and entries of another copy (a development checkout's: the
// uninstaller leaves them). It writes what a real installation writes (shortcuts, registry),
// so it refuses to run while Vilausity is installed, and puts File Explorer's entries and the
// vilaus:// key back as they were.
import { _electron as electron } from 'playwright-core';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const allUsers = process.argv.includes('--all-users');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const installer = path.join(root, 'release', `Vilausity-Setup-${version}.exe`);
if (!existsSync(installer)) {
  console.error(`installer: no ${installer}; npm run package first`);
  process.exit(2);
}

const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const reg = path.join(system32, 'reg.exe');
const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/**
 * electron-builder's key for this appId: UUID.v5(APP_ID, UUID.parse(ELECTRON_BUILDER_NS_UUID))
 * from builder-util-runtime (app-builder-lib's NsisTarget).
 */
const GUID = '255cf689-099c-51dc-8382-4cef000097e7';
const hive = allUsers ? 'HKEY_LOCAL_MACHINE' : 'HKEY_CURRENT_USER';
const installKey = `${hive}\\Software\\${GUID}`;
const uninstallKey = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${GUID}`;
const uriKey = `${hive}\\Software\\Classes\\vilaus`;
const MENU_PARENTS = ['Directory\\shell', 'Directory\\Background\\shell', 'Drive\\shell'];
const menuKey = (parent, administrator) =>
  `HKEY_CURRENT_USER\\Software\\Classes\\${parent}\\${administrator ? 'VilausityAdministrator' : 'Vilausity'}`;
const MENU_KEYS = MENU_PARENTS.flatMap((parent) => [menuKey(parent, false), menuKey(parent, true)]);
const FOLDER_ENTRY = menuKey(MENU_PARENTS[0], false);
const ELSEWHERE = '"C:\\Elsewhere\\Vilausity.exe" "%V"';

const runDir = path.join(root, '.test-data', `installer-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
// For all users: Program Files, where such an install goes. For the user: a folder with spaces
// and parentheses, which every command line has to quote.
const installDir = allUsers
  ? path.join(process.env.ProgramW6432 ?? 'C:\\Program Files', 'Vilausity')
  : path.join(runDir, 'Vilausity (test)');
const exe = path.join(installDir, 'Vilausity.exe');
const realSettings = path.join(process.env.APPDATA ?? '', 'Vilausity', 'settings.json');
const hadSettings = existsSync(realSettings);

// The installer starts the program (File Explorer's menu): the real registry, a clean environment.
const env = {};
for (const [name, value] of Object.entries(process.env)) {
  if (/^(electron_run_as_node|vilaus_registry_root)$/i.test(name) || /^vscode_/i.test(name)) continue;
  env[name] = value;
}

/** Runs PowerShell; its output as UTF-8. */
function ps(script) {
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}
/** A key's values (the default one as ''), or undefined when there is no such key. */
function readKey(key) {
  const json = ps(
    `$k = 'Registry::${key}'; if (Test-Path -LiteralPath $k) { $i = Get-Item -LiteralPath $k; $o = @{}; foreach ($n in $i.GetValueNames()) { $o[$n] = [string]$i.GetValue($n) }; $o | ConvertTo-Json -Compress } else { 'null' }`,
  );
  return JSON.parse(json || 'null') ?? undefined;
}
const commandOf = (key) => readKey(`${key}\\command`)?.[''];
function regDelete(key) {
  spawnSync(reg, ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true });
}
function regSetDefault(key, value) {
  execFileSync(reg, ['add', key, '/ve', '/d', value, '/f'], { stdio: 'ignore', windowsHide: true });
}
/** The desktop and Start menu shortcuts: the user's or everyone's. */
function shortcuts() {
  const folders = allUsers
    ? "[Environment]::GetFolderPath('CommonDesktopDirectory'); [Environment]::GetFolderPath('CommonPrograms')"
    : "[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')";
  return ps(folders)
    .split(/\r?\n/)
    .map((folder) => path.join(folder, 'Vilausity.lnk'));
}
const shortcutTarget = (file) => ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${file.replace(/'/g, "''")}').TargetPath`);
/** The installed program's processes (not another copy's). */
const runningCopies = () => ps(`@(Get-Process Vilausity -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' }).Count`);
function isElevated() {
  try {
    readdirSync(path.join(system32, 'config', 'systemprofile'));
    return true;
  } catch {
    return false;
  }
}
async function waitUntil(predicate, timeout, what) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

if (allUsers && !isElevated()) {
  console.error('installer: --all-users needs an elevated shell');
  process.exit(2);
}
for (const key of [`HKEY_CURRENT_USER\\Software\\${GUID}`, `HKEY_LOCAL_MACHINE\\Software\\${GUID}`]) {
  const location = readKey(key)?.InstallLocation;
  if (location) {
    console.error(`installer: Vilausity is installed in ${location}; uninstall it first`);
    process.exit(2);
  }
}

// Kept to put back: File Explorer's entries (a development checkout's, say) and the link key.
const saved = [...MENU_KEYS, uriKey].map((key, i) => {
  const file = path.join(runDir, `saved-${i}.reg`);
  const exported = spawnSync(reg, ['export', key, file, '/y'], { stdio: 'ignore', windowsHide: true }).status === 0;
  return { key, file: exported ? file : undefined };
});
function restore() {
  for (const { key, file } of saved) {
    regDelete(key);
    if (file) execFileSync(reg, ['import', file], { stdio: 'ignore', windowsHide: true });
  }
}

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS  ${name} (${Date.now() - started} ms)${detail ? ` - ${detail}` : ''}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL  ${name}: ${error?.message ?? error}`);
  }
}

const modeSwitch = allUsers ? '/allusers' : '/currentuser';

function install() {
  // NSIS takes /D= last and unquoted, spaces and all: a verbatim command line, with the
  // installer's own path quoted by hand.
  const args = ['/S', modeSwitch, ...(allUsers ? [] : [`/D=${installDir}`])];
  const run = spawnSync(installer, args, { env, argv0: `"${installer}"`, windowsVerbatimArguments: true, timeout: 300_000, windowsHide: true });
  if (run.status !== 0) throw new Error(`the installer exited with ${run.status}${run.error ? ` (${run.error.message})` : ''}`);
  if (!existsSync(exe)) throw new Error(`no ${exe}`);
}

async function uninstall() {
  const uninstaller = path.join(installDir, 'Uninstall Vilausity.exe');
  if (!existsSync(uninstaller)) throw new Error(`no ${uninstaller}`);
  // An NSIS uninstaller copies itself to %TEMP% and returns at once: wait for its work.
  spawnSync(uninstaller, ['/S', modeSwitch], { env, timeout: 120_000, windowsHide: true });
  await waitUntil(() => !readKey(uninstallKey) && !existsSync(installDir), 120_000, 'the uninstaller');
}

function checkInstalled() {
  const expectedFiles = ['Vilausity.exe', 'Uninstall Vilausity.exe', 'resources\\app.asar', 'LICENSE.txt', 'ThirdPartyNotices.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html'];
  const missing = expectedFiles.filter((file) => !existsSync(path.join(installDir, file)));
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`);
  const extra = ['resources\\default_app.asar', 'resources\\elevate.exe', 'version'].filter((file) => existsSync(path.join(installDir, file)));
  if (extra.length > 0) throw new Error(`should not be there: ${extra.join(', ')}`);
  const entry = readKey(uninstallKey);
  if (!entry) throw new Error(`no ${uninstallKey}`);
  const expected = { DisplayName: `Vilausity ${version}`, DisplayVersion: version, Publisher: 'Teabie' };
  for (const [name, value] of Object.entries(expected)) {
    if (entry[name] !== value) throw new Error(`uninstall entry ${name}: ${entry[name]}, not ${value}`);
  }
  if (!entry.UninstallString?.includes('Uninstall Vilausity.exe')) throw new Error(`UninstallString: ${entry.UninstallString}`);
  const location = readKey(installKey)?.InstallLocation ?? '';
  if (path.resolve(location) !== path.resolve(installDir)) throw new Error(`InstallLocation: ${location}`);
  for (const file of shortcuts()) {
    if (!existsSync(file)) throw new Error(`no shortcut ${file}`);
    const target = shortcutTarget(file);
    if (path.resolve(target) !== path.resolve(exe)) throw new Error(`${file} starts ${target}`);
  }
  const uri = readKey(uriKey);
  if (!uri || !('URL Protocol' in uri)) throw new Error(`no vilaus:// key in ${uriKey}`);
  const open = commandOf(`${uriKey}\\shell\\open`);
  if (open !== `"${exe}" -- "%1"`) throw new Error(`vilaus:// starts ${open}`);
  return `${installDir}; ${entry.DisplayName}, shortcuts and vilaus:// in place`;
}

function checkUninstalled() {
  if (existsSync(installDir)) throw new Error(`${installDir} is still there`);
  if (readKey(uninstallKey) || readKey(installKey)) throw new Error('the uninstall entry is still there');
  const left = shortcuts().filter((file) => existsSync(file));
  if (left.length > 0) throw new Error(`shortcuts left: ${left.join(', ')}`);
  if (readKey(uriKey)) throw new Error('the vilaus:// key is still there');
  if (hadSettings && !existsSync(realSettings)) throw new Error(`${realSettings} is gone`);
}

/** File Explorer's six entries all start the installed program (the administrator ones with --admin). */
function checkMenuIsOurs() {
  for (const parent of MENU_PARENTS) {
    for (const administrator of [false, true]) {
      const command = commandOf(menuKey(parent, administrator));
      const expected = `"${exe}"${administrator ? ' --admin' : ''} "%V"`;
      if (command !== expected) throw new Error(`${parent}${administrator ? ' (administrator)' : ''}: ${command}, not ${expected}`);
    }
  }
  return '6 entries';
}

/**
 * The installed program prints its version, shows its window and loads the extension (another
 * editor's copy); started from an elevated shell, as the administrator instance.
 */
async function checkProgramRuns() {
  // A GUI program attached to the console starts its output on a new line.
  const printed = execFileSync(exe, ['--version'], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true }).trim();
  if (printed.split(/\r?\n/)[0] !== `Vilausity ${version}`) throw new Error(`--version printed ${JSON.stringify(printed)}`);
  const workspace = path.join(runDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const testKey = `HKCU\\Software\\Vilausity-test\\installer-${Date.now()}`;
  const dataDir = path.join(runDir, `data-${Date.now()}`);
  const app = await electron.launch({
    executablePath: exe,
    args: ['--user-data-dir', dataDir, '--folder', workspace, '--secondary-display'],
    // Its own menu entries rewritten at start: into a test key.
    env: { ...env, VILAUS_REGISTRY_ROOT: `${testKey}\\Classes` },
    timeout: 60_000,
  });
  try {
    const page = await app.firstWindow();
    await waitUntil(() => page.frames().some((frame) => frame.url().startsWith('ccw://wv')), 30_000, 'the conversation');
    if (!(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged))) throw new Error('not packaged');
    const administrator = existsSync(path.join(dataDir, 'admin'));
    if (administrator !== isElevated()) throw new Error(administrator ? 'the administrator instance from a normal shell' : 'not the administrator instance, elevated');
    return `${printed.split(/\r?\n/)[0]}; the window and the conversation load${administrator ? ' (the administrator instance)' : ''}`;
  } finally {
    await app.close();
    regDelete(testKey);
  }
}

/**
 * Started from a normal (not elevated) token, as from the Start menu: nothing may be written
 * into Program Files, and it is the normal instance.
 */
async function checkRunsUnelevated() {
  const dataDir = path.join(runDir, `data-normal-${Date.now()}`);
  const workspace = path.join(runDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const command = `"${exe}" --user-data-dir "${dataDir}" --folder "${workspace}" --secondary-display`;
  spawn(path.join(system32, 'runas.exe'), ['/trustlevel:0x20000', command], { env, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const log = () => {
    const logs = path.join(dataDir, 'logs');
    const session = existsSync(logs) ? readdirSync(logs).sort().at(-1) : undefined;
    const file = session ? path.join(logs, session, 'main.log') : '';
    return file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  try {
    await waitUntil(() => /Claude Code \S+ activated/.test(log()), 60_000, 'the extension to activate in the normal instance');
    if (existsSync(path.join(dataDir, 'admin'))) throw new Error('it ran as the administrator instance');
    const errors = log()
      .split('\n')
      .filter((line) => line.includes('[error]'));
    if (errors.length > 0) throw new Error(`errors in main.log:\n${errors.join('\n')}`);
    return 'the normal instance; the extension activated; no errors';
  } finally {
    ps(`Get-Process Vilausity -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' } | Stop-Process -Force`);
    await waitUntil(() => runningCopies() === '0', 20_000, 'the program to quit');
  }
}

const mode = allUsers ? 'for all users' : 'for the current user';
try {
  // Round 1: an earlier install's entries are there; the install keeps them, for this copy.
  for (const key of MENU_KEYS) regDelete(key);
  regSetDefault(`${FOLDER_ENTRY}\\command`, ELSEWHERE);
  await step(`a silent install ${mode} puts the program, its shortcuts, the uninstall entry and vilaus:// in place`, async () => {
    install();
    return checkInstalled();
  });
  await step("File Explorer's entries that were there now start the installed program", async () => checkMenuIsOurs());
  await step('the installed program runs', checkProgramRuns);
  if (allUsers) await step('the installed program runs from a normal token, as the normal instance', checkRunsUnelevated);
  await step('a silent uninstall removes the program, the shortcuts, the entries and vilaus://; the data stays', async () => {
    await uninstall();
    checkUninstalled();
    const left = MENU_KEYS.filter((key) => readKey(key));
    if (left.length > 0) throw new Error(`entries left: ${left.join(', ')}`);
  });

  // Round 2: no entries; then another copy's (a development checkout's) show up. Uninstalling leaves them.
  for (const key of MENU_KEYS) regDelete(key);
  await step("an install without File Explorer's entries adds none", async () => {
    install();
    checkInstalled();
    const added = MENU_KEYS.filter((key) => readKey(key));
    if (added.length > 0) throw new Error(`added: ${added.join(', ')}`);
  });
  await step("uninstalling leaves another copy's File Explorer entries", async () => {
    regSetDefault(`${FOLDER_ENTRY}\\command`, ELSEWHERE);
    await uninstall();
    checkUninstalled();
    const command = commandOf(FOLDER_ENTRY);
    if (command !== ELSEWHERE) throw new Error(`the entry now: ${command}`);
  });
} finally {
  // A failed round may leave the program installed.
  if (existsSync(path.join(installDir, 'Uninstall Vilausity.exe'))) {
    await uninstall().catch((error) => console.log(`cleanup: ${error.message}`));
  }
  restore();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Artifacts: ${runDir}`);
if (failed === 0) rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
process.exit(failed === 0 ? 0 : 1);
