// Shell UI test: keybindings, sidebar, conversation tabs, command palette, themes, find, zoom,
// context menus, restart restore.
// Sends no messages to Claude (no usage).   npm run build && node tests/ui.mjs
// UI_ONLY=<regex> runs only the steps whose name matches, e.g. 'chat panel|keyboard shortcuts' (the first
// step waits for the window to be ready; some steps need others before them).
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// VILAUS_EXECUTABLE=release\win-unpacked\Vilausity.exe runs the steps against the packaged
// program (npm run package:dir): its asar, its fuses, its paths. Otherwise electron.exe runs
// this checkout's dist/, and needs the app's folder first.
const packaged = process.env.VILAUS_EXECUTABLE ? path.resolve(process.env.VILAUS_EXECUTABLE) : undefined;
const executable = packaged ?? electronPath;
const appArgs = (...args) => (packaged ? args : ['.', ...args]);
const runDir = path.join(root, '.test-data', `ui-${Date.now()}`);
const dataDir = path.join(runDir, 'data');
const workspace = path.join(runDir, 'workspace');
mkdirSync(dataDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
// English, whatever the system language: the steps look for English labels. The last
// step switches to Chinese.
const settingsFile = path.join(dataDir, 'settings.json');
// No automatic extension updates: they would download from Open VSX during the run.
writeFileSync(
  settingsFile,
  JSON.stringify({ 'claudeCode.hideOnboarding': true, 'vilaus.language': 'en', 'vilaus.extension.autoUpdate': false }),
  'utf8',
);

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE' || name.toUpperCase().startsWith('VSCODE_')) delete env[name];
}
// The normal instance even when the run starts from an elevated shell (an administrator
// instance keeps its state apart and marks its windows).
env.VILAUS_ELEVATED = '0';
// A conversation for the search to find, instead of the real ones in ~/.claude/projects.
const sessionsDir = path.join(runDir, 'sessions');
mkdirSync(path.join(sessionsDir, 'project'), { recursive: true });
writeFileSync(
  path.join(sessionsDir, 'project', '00000000-0000-4000-8000-000000000001.jsonl'),
  [
    { type: 'user', cwd: workspace, message: { role: 'user', content: 'Sort the receipts in Downloads by month' } },
    {
      type: 'assistant',
      cwd: workspace,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Moved 12 receipts.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: path.join(workspace, 'ledger.csv') } },
        ],
      },
    },
    { type: 'ai-title', aiTitle: 'Receipts by month' },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n'),
  'utf8',
);
env.VILAUS_SESSIONS_DIR = sessionsDir;
// File Explorer's menu entries go under a key of their own, not into the real menu.
const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
const registryTestKey = `HKCU\\Software\\Vilausity-test\\ui-${Date.now()}`;
env.VILAUS_REGISTRY_ROOT = `${registryTestKey}\\Classes`;

/**
 * Listens on a free port Chromium agrees to fetch from: it refuses a list of "unsafe" ports
 * (net::ERR_UNSAFE_PORT), and the system hands those out now and then (3659 once did).
 */
const CHROMIUM_UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
  989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
async function listenOnSafePort(server) {
  for (;;) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    if (!CHROMIUM_UNSAFE_PORTS.has(server.address().port)) return server.address().port;
    await new Promise((resolve) => server.close(resolve));
  }
}

// The About section asks GitHub for the latest release. It gets a local stand-in instead:
// no test reaches the real GitHub. It fails until the About step says otherwise, so that
// step can see the failure state and try Retry.
let releasesRespond = false;
const releasesRequests = [];
const releasesServer = createServer((request, response) => {
  releasesRequests.push(request.url ?? '');
  if (!releasesRespond) {
    response.writeHead(503, { 'content-type': 'text/plain' }).end('not yet');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify([
      { tag_name: 'v9.9.9', draft: true, published_at: '2026-10-25T00:00:00Z', html_url: 'https://example.invalid/draft' },
      { tag_name: 'v0.9.3', draft: false, published_at: '2026-09-01T00:00:00Z', html_url: 'https://example.invalid/0.9.3' },
      {
        tag_name: 'v0.9.5-beta.1',
        draft: false,
        prerelease: true,
        published_at: '2026-10-23T00:00:00Z',
        html_url: 'https://example.invalid/0.9.5-beta.1',
      },
    ]),
  );
});
env.VILAUS_RELEASES_API_URL = `http://127.0.0.1:${await listenOnSafePort(releasesServer)}/releases`;

const results = [];
/**
 * A step still going by then hangs: a page whose script never yields does not answer Playwright,
 * and waitFor cannot time out a call that never returns. The run stops there.
 */
const STEP_TIMEOUT_MS = 5 * 60_000;
const HUNG = Symbol('hung');
async function step(name, fn) {
  if (process.env.UI_ONLY && !new RegExp(process.env.UI_ONLY).test(name)) return;
  const started = Date.now();
  let timer;
  try {
    const detail = await Promise.race([fn(), new Promise((resolve) => (timer = setTimeout(resolve, STEP_TIMEOUT_MS, HUNG)))]);
    if (detail === HUNG) stopHungRun(name);
    results.push(true);
    console.log(`PASS  ${name} (${Date.now() - started} ms)${detail ? ` - ${detail}` : ''}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL  ${name}: ${error?.message ?? error}`);
  } finally {
    clearTimeout(timer);
  }
}
function stopHungRun(name) {
  console.log(`FAIL  ${name}: still going after ${STEP_TIMEOUT_MS / 60_000} min, the run stops (a page or a process no longer answers)`);
  console.log(`${results.filter((ok) => ok).length}/${results.length + 1} passed. Artifacts: ${runDir}`);
  // Every process of the run has a folder of runDir on its command line; Playwright would wait on them.
  if (!runDir.includes('.test-data')) throw new Error(`not a run's folder: "${runDir}"`);
  const script = `Get-CimInstance Win32_Process -Filter "Name='electron.exe' or Name='claude.exe' or Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${runDir}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore', windowsHide: true });
  process.exit(1);
}

const launch = () =>
  electron.launch({
    executablePath: executable,
    // On a second monitor, if there is one, out of the way of whoever started the run.
    args: appArgs('--user-data-dir', dataDir, '--folder', workspace, '--secondary-display'),
    cwd: root,
    env,
    timeout: 60_000,
  });
let app = await launch();
let page = await app.firstWindow();

async function waitFor(predicate, timeout, what) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await page.waitForTimeout(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const tabCount = () => page.locator('#tabs .tab').count();
const webviewFrames = () => page.frames().filter((f) => f.url().startsWith('ccw://wv'));

/** A shell window's title ends in `<folder name> - Vilausity` (the active conversation's title comes first). */
const windowTitle = (folder) => `${path.basename(folder)} - Vilausity`;
const showsFolder = (title, folder) => title === windowTitle(folder) || title.endsWith(` - ${windowTitle(folder)}`);

/**
 * Presses a shortcut through Electron's input pipeline (webContents.sendInputEvent), the
 * same path real keyboard input takes. Playwright's keyboard goes through the DevTools
 * protocol, which bypasses main's before-input-event and so our intercepted shortcuts.
 * `target`: 'main' (the test workspace's window), 'aux' (a tab's own window), or a folder
 * whose window gets the keys.
 */
async function press(shortcut, target = 'main') {
  const parts = shortcut.split('+');
  const keyCode = parts.pop();
  const modifiers = parts.map((m) => m.toLowerCase());
  const title = target === 'aux' ? undefined : windowTitle(target === 'main' ? workspace : target);
  await app.evaluate(
    ({ BrowserWindow }, { keyCode, modifiers, title }) => {
      // Shell windows show ccw://app; a tab's own window is a blank page the shell fills.
      const window = BrowserWindow.getAllWindows().find((w) =>
        title
          ? w.webContents.getURL().startsWith('ccw://app/') && (w.getTitle() === title || w.getTitle().endsWith(` - ${title}`))
          : w.webContents.getURL() === 'about:blank',
      );
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    },
    { keyCode, modifiers, title },
  );
}

/** The shell windows' pages (not tabs' own windows). */
const shellPages = () => app.windows().filter((candidate) => candidate.url().startsWith('ccw://app/'));
/** What the folder button and the Open Folder commands end up calling. */
const openFolder = (from, folder, newWindow) =>
  from.evaluate((params) => window.vilausNative.invoke('window.openFolder', params), { folder, newWindow });

await step('chat panel and session list load', async () => {
  await waitFor(async () => (await tabCount()) === 1, 30_000, 'the first conversation tab');
  await waitFor(() => webviewFrames().length >= 2, 30_000, 'two webviews (chat + session list)');
  return `${webviewFrames().length} webviews`;
});

await step('Ctrl+B toggles the session list', async () => {
  await press('Control+B');
  await waitFor(() => page.locator('#sidebar').isHidden(), 5000, 'the sidebar to hide');
  await press('Control+B');
  await waitFor(() => page.locator('#sidebar').isVisible(), 5000, 'the sidebar to show');
});

await step('Ctrl+N opens a conversation, Ctrl+Tab cycles, Ctrl+W closes; the tab row shows only with several', async () => {
  if (await page.locator('#tabs').isVisible()) throw new Error('the tab row shows with one conversation');
  await press('Control+N');
  await waitFor(async () => (await tabCount()) === 2, 20_000, 'a second tab');
  await waitFor(() => page.locator('#tabs').isVisible(), 5000, 'the tab row to show');
  const activeBefore = await page.locator('#tabs .tab.active').getAttribute('data-panel-id');
  await press('Control+Tab');
  await waitFor(
    async () => (await page.locator('#tabs .tab.active').getAttribute('data-panel-id')) !== activeBefore,
    5000,
    'Ctrl+Tab to switch tabs',
  );
  await press('Control+W');
  await waitFor(async () => (await tabCount()) === 1, 10_000, 'the tab to close');
  await waitFor(() => page.locator('#tabs').isHidden(), 5000, 'the tab row to hide');
});

await step('command palette switches the color theme for shell and webviews', async () => {
  await press('Control+Shift+P');
  const filter = page.locator('.quick-input-filter');
  await filter.waitFor({ timeout: 5000 });
  await filter.fill('>Color Theme');
  await filter.press('Enter');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 1, 5000, 'the theme list');
  await page.locator('.quick-input-filter').fill('Light Modern');
  await page.locator('.quick-input-filter').press('Enter');
  await waitFor(() => page.evaluate(() => document.body.classList.contains('vscode-light')), 5000, 'the shell to turn light');
  const chat = webviewFrames()[0];
  await waitFor(() => chat.evaluate(() => document.body.classList.contains('vscode-light')), 5000, 'the webview to turn light');
  // Back to the default.
  await press('Control+Shift+P');
  await page.locator('.quick-input-filter').fill('>Color Theme');
  await page.locator('.quick-input-filter').press('Enter');
  await page.locator('.quick-input-filter').fill('Dark Modern');
  await page.locator('.quick-input-filter').press('Enter');
  await waitFor(() => page.evaluate(() => document.body.classList.contains('vscode-dark')), 5000, 'the shell to turn dark');
});

await step('the search box finds conversations by title, words and files; > lists commands', async () => {
  const label = await page.locator('.search-box').innerText();
  const actions = await page.locator('.search-box .search-box-action').evaluateAll((buttons) => buttons.map((b) => b.ariaLabel));
  if (!label.startsWith('Workspace: ') || actions.join() !== 'Reveal Folder in File Explorer,Open Terminal in Workspace') {
    throw new Error(`the search box: "${label}", buttons ${actions.join(', ')}`);
  }
  const opening = Date.now();
  await page.locator('.search-box-open').click();
  const filter = page.locator('.quick-input-filter');
  await filter.waitFor({ timeout: 5000 });
  // The recent conversations were read soon after the window opened: they show at once (the time is reported).
  await page.locator('.quick-input-separator', { hasText: 'Recent Conversations' }).waitFor({ timeout: 10_000 });
  const shownIn = Date.now() - opening;
  // The picker opens over the box, which seems to grow into it.
  const [box, picker] = await page.evaluate(() =>
    ['.search-box', '.overlay-box.quick-input'].map((selector) => document.querySelector(selector).getBoundingClientRect().toJSON()),
  );
  if (picker.top > box.top + 1 || picker.left > box.left + 1 || picker.right < box.right - 1) {
    throw new Error(`the picker at ${JSON.stringify(picker)} does not cover the box at ${JSON.stringify(box)}`);
  }
  // With nothing typed, the last group is the commands: the palette, and the command run last
  // (the color theme, in the step before).
  await page.locator('.quick-input-separator', { hasText: 'Commands' }).waitFor({ timeout: 5000 });
  await page.locator('.quick-input-item', { hasText: 'Show All Commands' }).waitFor({ timeout: 5000 });
  await page.locator('.quick-input-item', { hasText: 'Color Theme' }).waitFor({ timeout: 5000 });
  const row = page.locator('.quick-input-item', { hasText: 'Receipts by month' });
  await row.waitFor({ timeout: 10_000 });
  // A title longer than the list is wide is cut short on its row's one line: the row is as high as before.
  const [high, highWithLongTitle] = await row.evaluate((element) => {
    const label = element.querySelector('.quick-input-label');
    const title = label.textContent;
    const before = element.getBoundingClientRect().height;
    label.textContent =
      'Sort the receipts in Downloads by month, then make a table of the totals, mail it to me and look for receipts that came twice';
    const after = element.getBoundingClientRect().height;
    label.textContent = title;
    return [before, after];
  });
  if (highWithLongTitle !== high) throw new Error(`a long title makes its row ${highWithLongTitle} px high, not ${high}`);
  for (const [query, detail] of [
    ['receipts', undefined],
    ['downloads', 'You: Sort the receipts in Downloads by month'],
    ['ledger.csv', 'Changed: ledger.csv'],
  ]) {
    await filter.fill(query);
    await waitFor(
      async () => (await row.count()) === 1 && (detail === undefined || (await row.locator('.quick-input-detail').innerText()) === detail),
      5000,
      `the conversation found by "${query}"`,
    );
  }
  await filter.fill('>Toggle Developer');
  await waitFor(
    async () => (await page.locator('.quick-input-item', { hasText: 'Toggle Developer Tools' }).count()) === 1,
    5000,
    'the command',
  );
  await filter.press('Escape');
  await waitFor(async () => (await page.locator('.quick-input-filter').count()) === 0, 3000, 'the picker to close');
  return `recent conversations shown ${shownIn} ms after the click`;
});

/** The main window's bounds; `bounds` given, it moves there first. */
const mainWindowBounds = (bounds) =>
  app.evaluate(
    ({ BrowserWindow }, { title, bounds }) => {
      const window = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL().startsWith('ccw://app/') && (w.getTitle() === title || w.getTitle().endsWith(` - ${title}`)),
      );
      if (bounds) window.setBounds(bounds);
      return window.getBounds();
    },
    { title: windowTitle(workspace), bounds },
  );

await step(
  'the search box sits mid-window; its picker covers it, also narrow with a long provider name, clear of the window buttons',
  async () => {
    const rects = () =>
      page.evaluate(() =>
        Object.fromEntries(
          [
            ['left', '.titlebar-main > .titlebar-left'],
            ['right', '.titlebar-main > .titlebar-right'],
            ['box', '.search-box'],
            ['controls', '.titlebar-main .titlebar-controls-space'],
          ].map(([name, selector]) => [name, document.querySelector(selector).getBoundingClientRect().toJSON()]),
        ),
      );
    const covered = async (what) => {
      const searchBox = page.locator('.search-box');
      await page.locator('.search-box-open').click();
      const picker = await page.locator('.overlay-box.quick-input').evaluate((element) => element.getBoundingClientRect().toJSON());
      const { box, controls } = await rects();
      // Its corners are smaller than the picker's: it hides while open, and comes back after.
      const hidden = !(await searchBox.isVisible());
      await page.locator('.quick-input-filter').press('Escape');
      await waitFor(async () => (await page.locator('.quick-input-filter').count()) === 0, 3000, 'the picker to close');
      const back = await waitFor(() => searchBox.isVisible(), 3000, 'the search box back after the picker');
      if (!hidden) throw new Error(`${what}: the search box shows under the picker`);
      if (picker.left > box.left + 1 || picker.right < box.right - 1 || picker.right > controls.left) {
        throw new Error(
          `${what}: the picker spans ${picker.left}-${picker.right}, the box ${box.left}-${box.right}, the window buttons start at ${controls.left}`,
        );
      }
      return `${what}: box ${Math.round(box.left)}-${Math.round(box.right)} (hidden while open, back after: ${back}), picker ${Math.round(picker.left)}-${Math.round(picker.right)}`;
    };
    const original = await mainWindowBounds();
    const providerLabel = page.locator('.titlebar-provider-label');
    const providerName = await providerLabel.innerText();
    try {
      // Wide enough for the box to be as wide as the picker: off by a pixel, it would show beside it.
      await mainWindowBounds({ ...original, width: 1700 });
      await waitFor(async () => (await rects()).box.width >= 599, 5000, 'the box at its widest');
      const { left, right } = await rects();
      if (Math.abs(left.width - right.width) > 1) throw new Error(`the title bar's sides are ${left.width} and ${right.width} px wide`);
      const wide = await covered('wide');
      // Narrow, with a crowded left side: the box is off the middle, and the picker goes with it.
      await providerLabel.evaluate((element) => (element.textContent = 'A provider with a long name'));
      await mainWindowBounds({ ...original, width: 700 });
      await waitFor(async () => (await rects()).box.width < 400, 5000, 'the narrow box');
      const narrow = await covered('narrow');
      return `${wide}; ${narrow}`;
    } finally {
      await providerLabel.evaluate((element, name) => (element.textContent = name), providerName);
      await mainWindowBounds(original);
    }
  },
);

await step('the terminal button opens terminal.external.windowsExec in the workspace folder', async () => {
  // A script for a terminal: Windows runs it without a window, and it writes where it ran.
  const script = path.join(runDir, 'fake-terminal.vbs');
  const written = `${script}.cwd`;
  writeFileSync(
    script,
    [
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      'Set f = fso.CreateTextFile(WScript.ScriptFullName & ".cwd", True)',
      'f.WriteLine CreateObject("WScript.Shell").CurrentDirectory',
      'f.Close',
    ].join('\r\n'),
  );
  const before = readFileSync(settingsFile, 'utf8');
  writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(before), 'terminal.external.windowsExec': script }, null, 2), 'utf8');
  try {
    // Main has the setting before the click; otherwise the real terminal would open.
    await waitFor(
      async () =>
        (await page.evaluate(() => window.vilausNative.invoke('settings.read'))).values['terminal.external.windowsExec'] === script,
      5000,
      'main to read the setting',
    );
    await page.locator('.search-box-action[aria-label="Open Terminal in Workspace"]').click();
    await waitFor(() => existsSync(written), 10_000, 'the program to run');
    const cwd = readFileSync(written, 'utf8').trim();
    if (cwd.toLowerCase() !== workspace.toLowerCase()) throw new Error(`it ran in ${cwd}`);
    // With nothing typed, the search lists both under Folders.
    await press('Control+P');
    for (const name of ['Reveal Folder in File Explorer', 'Open Terminal in Workspace']) {
      await page.locator('.quick-input-item', { hasText: name }).waitFor({ timeout: 5000 });
    }
    await page.locator('.quick-input-filter').press('Escape');
    return cwd;
  } finally {
    writeFileSync(settingsFile, before, 'utf8');
  }
});

await step('Ctrl+F finds text in the active conversation', async () => {
  // A just-opened conversation renders its welcome content a moment later (the session list
  // may show the word first, so look in the active conversation).
  await waitFor(
    async () => {
      const handle = await page.locator('#main .panel:not([hidden]) .webview-frame').elementHandle();
      const frame = await handle?.contentFrame();
      return frame ? frame.evaluate(() => document.body.innerText.includes('Claude')).catch(() => false) : false;
    },
    10_000,
    'conversation content',
  );
  await press('Control+F');
  const input = page.locator('.find-input');
  await input.waitFor({ timeout: 5000 });
  await input.fill('Claude');
  const count = await waitFor(
    async () => {
      const text = await page.locator('.find-count').innerText();
      return /^\d+ of \d+$/.test(text) ? text : undefined;
    },
    5000,
    'a match count',
  );
  await input.press('Enter');
  await waitFor(async () => (await page.locator('.find-count').innerText()).startsWith('2 of'), 3000, 'Enter to move to match 2');
  await input.press('Escape');
  await waitFor(() => page.locator('.find-widget').isHidden(), 3000, 'the find widget to close');
  return count;
});
await step('Ctrl+= zooms in and Ctrl+0 resets', async () => {
  const before = await page.evaluate(() => window.devicePixelRatio);
  await press('Control+=');
  await waitFor(async () => (await page.evaluate(() => window.devicePixelRatio)) > before, 3000, 'zoom in');
  await press('Control+0');
  await waitFor(async () => (await page.evaluate(() => window.devicePixelRatio)) === before, 3000, 'zoom reset');
});

/**
 * Right-clicks with Playwright's mouse. Unlike keys (see press()), mouse input must not go
 * through webContents.sendInputEvent: that injects into the top frame and skips Chromium's
 * routing into out-of-process iframes, so the menu would belong to the shell page instead
 * of the webview. DevTools-protocol input is routed like real input.
 */
async function rightClick(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('nothing to right-click');
  await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 3), { button: 'right' });
}

/** Runs `fn` while native menus are recorded instead of shown (a shown menu blocks the test). */
async function withRecordedMenus(fn) {
  await app.evaluate(({ Menu }) => {
    // Kept to be put back on the prototype, never called on its own.
    // oxlint-disable-next-line typescript/unbound-method
    globalThis.vilausRealPopup = Menu.prototype.popup;
    Menu.prototype.popup = function () {
      globalThis.vilausLastMenu = this;
    };
  });
  try {
    return await fn();
  } finally {
    await app.evaluate(({ Menu }) => {
      Menu.prototype.popup = globalThis.vilausRealPopup;
      delete globalThis.vilausLastMenu;
    });
  }
}
const recordedMenu = () =>
  app.evaluate(() => globalThis.vilausLastMenu?.items.map((item) => (item.type === 'separator' ? '---' : item.label)));
const clickRecordedMenuItem = (label) =>
  app.evaluate((_electron, label) => {
    globalThis.vilausLastMenu.items.find((item) => item.label === label).click();
  }, label);
const activeConversation = () => page.locator('#main .panel:not([hidden]) .webview-frame');

/** Right-clicks until the menu shows: a click just after the page moved (a zoom reset) can miss. */
async function openContextMenu(locator) {
  for (let attempt = 1; ; attempt++) {
    await rightClick(locator);
    try {
      return await waitFor(recordedMenu, 2500, 'the context menu');
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}
/** The extension's webview/context items, as an English UI shows them (sorted by title). */
const conversationMenu = ['Add Session Tab to Group', 'Mark Session as Unread', 'Rename Session Tab'];

await step('right-click in a conversation offers the extension menu; Rename Session Tab runs', () =>
  withRecordedMenus(async () => {
    const labels = await openContextMenu(activeConversation());
    if (labels.filter((label) => conversationMenu.includes(label)).join('|') !== conversationMenu.join('|')) {
      throw new Error(`menu was: ${labels.join(' | ')}`);
    }

    // Right after the window opens the extension may not know the tab as its session's yet (it
    // says "No active Claude Code session tab"): a faster build gets here sooner. Ask again then.
    const deadline = Date.now() + 20_000;
    let outcome;
    for (;;) {
      await clickRecordedMenuItem('Rename Session Tab');
      outcome = await waitFor(
        async () => {
          if (await page.locator('.quick-input-filter').count()) return 'input box';
          const toast = page.locator('.toast-message');
          return (await toast.count()) ? `message "${await toast.first().innerText()}"` : undefined;
        },
        10_000,
        'the rename command to answer',
      );
      if (outcome === 'input box' || !outcome.includes('No active') || Date.now() > deadline) break;
      await page.locator('.toast-close').first().click();
      await page.waitForTimeout(1000);
      await openContextMenu(activeConversation());
    }
    if (outcome === 'input box') {
      // The extension's validateInput refuses an empty name; the shell asks again with its message.
      await page.locator('.quick-input-filter').fill('');
      await page.locator('.quick-input-filter').press('Enter');
      const message = await waitFor(
        async () => {
          const validation = page.locator('.quick-input-validation');
          return (await validation.count()) ? validation.innerText() : undefined;
        },
        5000,
        'the validation message',
      );
      await page.locator('.quick-input-filter').press('Escape');
      await waitFor(async () => (await page.locator('.quick-input-filter').count()) === 0, 3000, 'the input box to close');
      return `${labels.length} menu entries; rename asked for a name, empty refused ("${message}"), cancelled`;
    }
    await page.locator('.toast-close').first().click();
    return `${labels.length} menu entries; rename answered with ${outcome}`;
  }),
);

await step('Add Session Tab to Group from the conversation menu shows the group picker', () =>
  withRecordedMenus(async () => {
    await openContextMenu(activeConversation());
    await clickRecordedMenuItem('Add Session Tab to Group');
    const items = await waitFor(
      async () => {
        const rows = page.locator('.quick-input-item');
        return (await rows.count()) ? rows.allInnerTexts() : undefined;
      },
      10_000,
      'the group picker',
    );
    await page.locator('.quick-input-filter').press('Escape');
    await waitFor(async () => (await page.locator('.quick-input-filter').count()) === 0, 3000, 'the picker to close');
    if (!items.some((item) => item.startsWith('New group'))) throw new Error(`picker had: ${items.join(' | ')}`);
    return `picker: ${items.join(' | ')}`;
  }),
);

await step('right-click in the session list does not offer the conversation menu', () =>
  withRecordedMenus(async () => {
    await rightClick(page.locator('#sidebar .webview-frame'));
    await page.waitForTimeout(1000);
    const labels = (await recordedMenu()) ?? [];
    if (labels.some((label) => conversationMenu.includes(label))) throw new Error(`menu was: ${labels.join(' | ')}`);
    return labels.length ? `menu: ${labels.join(' | ')}` : 'no menu';
  }),
);

// ---- content pane and editor ------------------------------------------------------------

const sampleFile = path.join(workspace, 'src', 'sample.ts');
const sampleText = 'export const answer: number = 42;\n// a comment\nfunction greet(name: string) {\n  return `hi ${name}`;\n}\n';
mkdirSync(path.dirname(sampleFile), { recursive: true });
writeFileSync(sampleFile, sampleText, 'utf8');
const contentTabs = () => page.locator('#content-pane .content-tab');
// Monaco renders spaces as no-break spaces. The last editor: a file shown beside its defaults is on the right.
const editorText = async () =>
  (await page.locator('#content-pane .content-editor:not([hidden]) .view-lines').last().innerText()).replace(/ /g, ' ');

await step('Ctrl+P opens a file in the content pane, highlighted', async () => {
  await press('Control+P');
  const filter = page.locator('.quick-input-filter');
  await filter.waitFor({ timeout: 5000 });
  await filter.fill('sampl');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'the file in the list');
  await filter.press('Enter');
  await waitFor(async () => (await contentTabs().count()) === 1, 15_000, 'a content tab');
  await waitFor(async () => (await editorText()).includes('answer'), 15_000, 'the file text in Monaco');
  // Tokens get colors once the grammar has loaded.
  const colors = await waitFor(
    async () => {
      const found = await page.evaluate(() => {
        const spans = document.querySelectorAll('#content-pane .view-line span span');
        return [...new Set([...spans].map((span) => getComputedStyle(span).color))];
      });
      return found.length >= 3 ? found : undefined;
    },
    15_000,
    'syntax colors',
  );
  await page.screenshot({ path: path.join(runDir, 'editor.png') });
  return `${colors.length} token colors`;
});

await step('the conversation sees the open file (selection sync)', async () => {
  const seen = await waitFor(
    async () => {
      for (const frame of webviewFrames()) {
        if (await frame.evaluate(() => document.body.innerText.includes('sample.ts')).catch(() => false)) return true;
      }
      return false;
    },
    10_000,
    'sample.ts in the chat',
  );
  return seen ? 'chat mentions sample.ts' : '';
});

await step('typing marks the tab dirty; Ctrl+S saves to disk', async () => {
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// edited');
  await waitFor(async () => (await page.locator('#content-pane .content-tab.dirty').count()) === 1, 5000, 'the dirty marker');
  await press('Control+S');
  await waitFor(() => readFileSync(sampleFile, 'utf8').includes('// edited'), 5000, 'the file on disk');
  await waitFor(async () => (await page.locator('#content-pane .content-tab.dirty').count()) === 0, 5000, 'the tab to be clean');
});

await step('a change on disk reloads the clean editor', async () => {
  writeFileSync(sampleFile, `${readFileSync(sampleFile, 'utf8')}\n// from outside\n`, 'utf8');
  await waitFor(async () => (await editorText()).includes('from outside'), 10_000, 'the editor to reload');
});

await step('Ctrl+/ toggles a line comment (the language configuration)', async () => {
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+/');
  await waitFor(async () => (await editorText()).includes('// export const answer'), 5000, 'the commented line');
  await page.keyboard.press('Control+Z');
  await waitFor(async () => !(await editorText()).includes('// export const answer'), 5000, 'the undo');
  await waitFor(async () => (await page.locator('#content-pane .content-tab.dirty').count()) === 0, 5000, 'the tab clean again');
});

await step('Compare Active File with Saved opens a diff tab (vscode.diff)', async () => {
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// unsaved\n');
  await press('Control+Shift+P');
  await page.locator('.quick-input-filter').fill('>Compare Active File with Saved');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) === 1, 5000, 'the command');
  await page.locator('.quick-input-filter').press('Enter');
  await waitFor(async () => (await contentTabs().count()) === 2, 10_000, 'a diff tab');
  await page.locator('#content-pane .monaco-diff-editor').waitFor({ timeout: 10_000 });
  // The diff is computed in Monaco's worker: inserted lines get marked once it answers.
  await waitFor(
    async () => (await page.locator('#content-pane .monaco-diff-editor :is(.line-insert, .char-insert)').count()) > 0,
    10_000,
    'the inserted line to be marked',
  );
  const label = await page.locator('#content-pane .content-tab.active .tab-label').innerText();
  await press('Control+W');
  await waitFor(async () => (await contentTabs().count()) === 1, 5000, 'the diff tab to close');
  // Back on the file: save, so later steps start clean.
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  await press('Control+S');
  await waitFor(async () => (await page.locator('#content-pane .content-tab.dirty').count()) === 0, 5000, 'the file to be saved');
  return label;
});

await step('a Markdown file opens as a preview, with highlighted code and a local image, and toggles to source', async () => {
  // A 1x1 PNG next to the document.
  mkdirSync(path.join(workspace, 'img'), { recursive: true });
  writeFileSync(
    path.join(workspace, 'img', 'dot.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
  );
  writeFileSync(
    path.join(workspace, 'notes.md'),
    '# Plan notes\n\nSee [the sample](src/sample.ts).\n\n![dot](img/dot.png)\n\n```ts\nconst x: number = 1;\n```\n',
    'utf8',
  );
  await press('Control+P');
  await page.locator('.quick-input-filter').fill('notes.md');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'notes.md in the list');
  await page.locator('.quick-input-filter').press('Enter');
  const heading = page.locator('#content-pane .markdown-preview:not([hidden]) h1');
  await waitFor(async () => (await heading.count()) === 1 && (await heading.innerText()) === 'Plan notes', 10_000, 'the rendered heading');
  await waitFor(
    async () => (await page.locator('#content-pane .markdown-preview pre.shiki').count()) === 1,
    10_000,
    'a highlighted code block',
  );
  await waitFor(
    () => page.locator('#content-pane .markdown-preview img').evaluate((img) => img.complete && img.naturalWidth > 0),
    5000,
    'the workspace image to load',
  );
  await page.locator('#content-pane .editor-toolbar .button', { hasText: 'Open Source' }).click();
  await waitFor(async () => (await editorText()).includes('# Plan notes'), 5000, 'the source view');
  await page.locator('#content-pane .editor-toolbar .button', { hasText: 'Open Preview' }).click();
  await waitFor(() => heading.isVisible(), 5000, 'the preview again');
  await page.locator('#content-pane .markdown-preview').click();
  await press('Control+W');
  await waitFor(async () => (await contentTabs().count()) === 1, 5000, 'the Markdown tab to close');
});

/** Runs a command from the palette by its title (the only match). */
async function runCommand(title) {
  await press('Control+Shift+P');
  await page.locator('.quick-input-filter').fill(`>${title}`);
  await waitFor(async () => (await page.locator('.quick-input-item').count()) === 1, 5000, `the command ${title}`);
  await page.locator('.quick-input-filter').press('Enter');
}

await step(
  'a Markdown file saves with Ctrl+S from its source and its preview; the dot says how to save; Revert and Compare act on it',
  async () => {
    const notes = path.join(workspace, 'notes.md');
    const dirtyTabs = () => page.locator('#content-pane .content-tab.dirty').count();
    const toggle = (label) => page.locator('#content-pane .editor-toolbar .button', { hasText: label }).click();
    await press('Control+P');
    await page.locator('.quick-input-filter').fill('notes.md');
    await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'notes.md in the list');
    await page.locator('.quick-input-filter').press('Enter');
    await page.locator('#content-pane .markdown-preview:not([hidden]) h1').waitFor({ timeout: 10_000 });

    // In the source view.
    await toggle('Open Source');
    await page.locator('#content-pane .content-editor:not([hidden]) .monaco-editor .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nSaved from the source.');
    await waitFor(async () => (await dirtyTabs()) === 1, 5000, 'the dirty marker');
    // The dot (the close button of a dirty tab) says how to save, with the key as it is bound now.
    await page.locator('#content-pane .content-tab.dirty .tab-close').hover();
    const tooltip = await page.locator('#content-pane .content-tab.dirty .tab-close').getAttribute('title');
    if (tooltip !== 'Unsaved (Ctrl+S to save)') throw new Error(`the dot's tooltip: ${tooltip}`);
    await page.locator('#content-pane .content-editor:not([hidden]) .monaco-editor .view-lines').click();
    await press('Control+S');
    await waitFor(() => readFileSync(notes, 'utf8').includes('Saved from the source.'), 5000, 'the source view to save');
    await waitFor(async () => (await dirtyTabs()) === 0, 5000, 'the tab clean');

    // An edit, then the preview: Ctrl+S there saves the same document.
    await page.keyboard.type('\n\nSaved from the preview.');
    await toggle('Open Preview');
    await page.locator('#content-pane .markdown-preview').click();
    await press('Control+S');
    await waitFor(() => readFileSync(notes, 'utf8').includes('Saved from the preview.'), 5000, 'the preview to save');
    await waitFor(async () => (await dirtyTabs()) === 0, 5000, 'the tab clean');

    // Revert File from the preview drops what was not saved.
    await toggle('Open Source');
    await page.locator('#content-pane .content-editor:not([hidden]) .monaco-editor .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nNot kept.');
    await toggle('Open Preview');
    await page.locator('#content-pane .markdown-preview').click();
    await runCommand('Revert File');
    await waitFor(async () => (await dirtyTabs()) === 0, 5000, 'the revert');
    if (readFileSync(notes, 'utf8').includes('Not kept.')) throw new Error('the reverted text reached the disk');

    // Compare with Saved, from the preview too.
    await toggle('Open Source');
    await page.locator('#content-pane .content-editor:not([hidden]) .monaco-editor .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nCompared.');
    await toggle('Open Preview');
    await page.locator('#content-pane .markdown-preview').click();
    await runCommand('Compare Active File with Saved');
    await waitFor(async () => (await contentTabs().count()) === 3, 10_000, 'a diff tab');
    await page.locator('#content-pane .content-editor:not([hidden]) .monaco-diff-editor').waitFor({ timeout: 10_000 });
    await press('Control+W');
    await waitFor(async () => (await contentTabs().count()) === 2, 5000, 'the diff tab to close');
    await page.locator('#content-pane .markdown-preview').click();
    await runCommand('Revert File');
    await waitFor(async () => (await dirtyTabs()) === 0, 5000, 'the revert');
    await page.locator('#content-pane .markdown-preview').click();
    await press('Control+W');
    await waitFor(async () => (await contentTabs().count()) === 1, 5000, 'the Markdown tab to close');
  },
);

await step('Files: Auto Save set to afterDelay saves an edited file by itself', async () => {
  const settingsBefore = readFileSync(settingsFile, 'utf8');
  const sampleBefore = readFileSync(sampleFile, 'utf8');
  const autoSaving = { ...JSON.parse(settingsBefore), 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 300 };
  writeFileSync(settingsFile, JSON.stringify(autoSaving, null, 2), 'utf8');
  await page.locator('#content-pane .content-editor:not([hidden]) .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// saved by itself');
  await waitFor(() => readFileSync(sampleFile, 'utf8').includes('// saved by itself'), 5000, 'the file saved without Ctrl+S');
  await waitFor(async () => (await page.locator('#content-pane .content-tab.dirty').count()) === 0, 5000, 'the tab clean');
  writeFileSync(settingsFile, settingsBefore, 'utf8');
  writeFileSync(sampleFile, sampleBefore, 'utf8');
  await waitFor(async () => !(await editorText()).includes('saved by itself'), 10_000, 'the file as it was');
});

// ---- M3: comments on selected text --------------------------------------------------------

const conversationFrame = async () => (await activeConversation().elementHandle())?.contentFrame();
const commentBlocks = (frame) => frame.locator('.vilaus-comments .vilaus-comment');
const editorLine = (text) => page.locator('#content-pane .content-editor:not([hidden]) .view-line', { hasText: text }).first();

async function submitCommentForm(text) {
  const input = page.locator('.comment-form-input');
  await input.waitFor({ timeout: 5000 });
  await input.fill(text);
  await input.press('Enter');
  await waitFor(async () => (await page.locator('.comment-form').count()) === 0, 5000, 'the comment form to close');
}

async function addComment(text) {
  const button = page.locator('.selection-toolbar-button', { hasText: 'Comment' });
  await waitFor(async () => (await button.count()) > 0, 5000, 'the Comment button by the selection');
  await button.click();
  await submitCommentForm(text);
}

await step('selecting text in an editor offers Comment; the comment shows above the conversation input', async () => {
  const box = await editorLine('answer').boundingBox();
  await page.mouse.move(box.x + 100, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await addComment('Why 42?');
  const frame = await conversationFrame();
  await waitFor(async () => (await commentBlocks(frame).count()) === 1, 5000, 'a block in the conversation');
  const placed = await frame.evaluate(() => {
    const next = document.querySelector('.vilaus-comments')?.nextElementSibling;
    return next?.tagName === 'FORM' && next.querySelector('[role="textbox"][aria-label="Message input"]') !== null;
  });
  if (!placed) throw new Error('the blocks are not right before the input form');
  // Earlier steps added lines above it; the label carries the line it is on now.
  const source = await commentBlocks(frame).first().locator('.vilaus-comment-source').innerText();
  if (!/^sample\.ts:\d+$/.test(source)) throw new Error(`the block points at ${source}`);
  await page.screenshot({ path: path.join(runDir, 'comments.png') });
  return source;
});

await step('a selection in the Markdown preview is commented with its source line', async () => {
  await press('Control+P');
  await page.locator('.quick-input-filter').fill('notes.md');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'notes.md in the list');
  await page.locator('.quick-input-filter').press('Enter');
  const preview = page.locator('#content-pane .content-editor:not([hidden]) .markdown-preview');
  await waitFor(async () => (await preview.locator('h1').count()) === 1, 10_000, 'the preview');
  await preview.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf('the sample');
      if (at >= 0) {
        document.getSelection().setBaseAndExtent(node, at, node, at + 'the sample'.length);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return;
      }
    }
  });
  await addComment('Is this the right file?');
  const frame = await conversationFrame();
  await waitFor(async () => (await commentBlocks(frame).count()) === 2, 5000, 'two blocks');
  // Newest on top; "the sample" is on line 3 of the source.
  const source = await commentBlocks(frame).first().locator('.vilaus-comment-source').innerText();
  if (source !== 'notes.md:3') throw new Error(`the newest block points at ${source}`);
  return source;
});

await step('a comment block edits in place, shows its text in the editor, and deletes', async () => {
  const frame = await conversationFrame();
  const blocks = commentBlocks(frame);
  await blocks.first().hover();
  await blocks.first().locator('[data-action="edit"]').click();
  const input = page.locator('.comment-form-overlay .comment-form-input');
  await input.waitFor({ timeout: 5000 });
  if ((await input.inputValue()) !== 'Is this the right file?') throw new Error(`the form holds "${await input.inputValue()}"`);
  await input.fill('Link the README instead.');
  await input.press('Enter');
  const text = blocks.first().locator('.vilaus-comment-text');
  await waitFor(async () => (await text.innerText()) === 'Link the README instead.', 5000, 'the edited text');

  // The older block points into sample.ts, a tab behind notes.md.
  await blocks.last().locator('[data-action="reveal"]').click();
  await waitFor(
    async () => (await page.locator('#content-pane .content-tab.active .tab-label').innerText()) === 'sample.ts',
    5000,
    'sample.ts to come forward',
  );
  await waitFor(
    async () => (await page.locator('#content-pane .content-editor:not([hidden]) .selected-text').count()) > 0,
    5000,
    'the commented text selected',
  );

  await blocks.first().hover();
  await blocks.first().locator('[data-action="remove"]').click();
  await waitFor(async () => (await blocks.count()) === 1, 5000, 'one block left');
});

await step('Ctrl+Alt+M comments on the selection; more than three comments fold into a count', async () => {
  for (const word of ['greet', 'return', 'comment']) {
    await editorLine(word).click();
    await press('Home');
    await press('Shift+End');
    await press('Control+Alt+M');
    await submitCommentForm(`About ${word}`);
  }
  const frame = await conversationFrame();
  await waitFor(async () => (await commentBlocks(frame).count()) === 4, 5000, 'four blocks');
  if (!(await frame.locator('.vilaus-comments-list').isHidden())) throw new Error('four comments are not folded');
  const header = (await frame.locator('.vilaus-comments-toggle').innerText()).trim();
  if (header !== '4 comments') throw new Error(`the header says ${header}`);
  await frame.locator('.vilaus-comments-toggle').click();
  await waitFor(() => frame.locator('.vilaus-comments-list').isVisible(), 3000, 'the list to unfold');
  // As the steps below expect: sample.ts alone in the pane.
  await page.locator('#content-pane .content-tab', { hasText: 'notes.md' }).click({ button: 'middle' });
  await waitFor(async () => (await contentTabs().count()) === 1, 5000, 'notes.md to close');
  return header;
});

await step('Ctrl+W in the editor closes its tab and the pane hides; the conversation stays', async () => {
  const conversations = await tabCount();
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  await press('Control+W');
  await waitFor(async () => (await contentTabs().count()) === 0, 5000, 'the content tab to close');
  await waitFor(() => page.locator('#content-pane').isHidden(), 5000, 'the pane to hide');
  if ((await tabCount()) !== conversations) throw new Error('a conversation closed too');
});

await step('Escape in the editor closes its tab once nothing there uses it, and the conversation has the focus again', async () => {
  await press('Control+P');
  const filter = page.locator('.quick-input-filter');
  await filter.waitFor({ timeout: 5000 });
  await filter.fill('sampl');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'the file in the list');
  await filter.press('Enter');
  await waitFor(async () => (await contentTabs().count()) === 1, 15_000, 'a content tab');
  // A selection takes the first Escape (Monaco clears it), the second closes the tab.
  await editorLine('answer').dblclick();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  if ((await contentTabs().count()) !== 1) throw new Error('the first Escape closed the tab');
  await page.keyboard.press('Escape');
  await waitFor(async () => (await contentTabs().count()) === 0, 5000, 'the content tab to close');
  await waitFor(() => page.locator('#content-pane').isHidden(), 5000, 'the pane to hide');
  await waitFor(
    () => page.evaluate(() => document.activeElement?.closest('#main .panel:not([hidden])') !== null),
    5000,
    'the focus back in the conversation',
  );
});

await step('Claude: Show Logs opens the extension log in the content pane', async () => {
  await press('Control+Shift+P');
  await page.locator('.quick-input-filter').fill('>Claude: Show Logs');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) === 1, 5000, 'the command');
  await page.locator('.quick-input-filter').press('Enter');
  await waitFor(async () => (await contentTabs().count()) === 1, 10_000, 'the log tab');
  const label = await page.locator('#content-pane .content-tab.active .tab-label').innerText();
  if (!label.endsWith('.log')) throw new Error(`tab is ${label}`);
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  await press('Control+W');
  await waitFor(async () => (await contentTabs().count()) === 0, 5000, 'the log tab to close');
  return label;
});

await step('a tab moves into its own window, edits and saves there, and moves back', async () => {
  await press('Control+P');
  await page.locator('.quick-input-filter').fill('sample.ts');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'sample.ts in the list');
  await page.locator('.quick-input-filter').press('Enter');
  await waitFor(async () => (await editorText()).includes('answer'), 10_000, 'sample.ts in the pane');

  const opened = app.waitForEvent('window');
  await page.locator('#content-pane .icon-pop-out').click();
  const aux = await opened;
  const auxText = async () => (await aux.locator('.aux-body .view-lines').innerText()).replace(/ /g, ' ');
  await waitFor(
    async () => (await aux.locator('.aux-body .view-lines').count()) > 0 && (await auxText()).includes('answer'),
    10_000,
    'the editor in the new window',
  );
  // Monaco's generated styles (token colors) must reach the new window.
  const colors = await waitFor(
    async () => {
      const count = await aux.evaluate(
        () => new Set([...document.querySelectorAll('.view-line span span')].map((s) => getComputedStyle(s).color)).size,
      );
      return count >= 3 ? count : undefined;
    },
    10_000,
    'syntax colors in the new window',
  );
  if ((await contentTabs().count()) !== 0) throw new Error('the tab stayed in the pane');
  await aux.screenshot({ path: path.join(runDir, 'aux-window.png') });

  await aux.locator('.aux-body .view-lines').click();
  await aux.keyboard.press('Control+End');
  await aux.keyboard.type('// from the window');
  await waitFor(async () => (await aux.locator('.aux-title.dirty').count()) === 1, 5000, 'the unsaved mark in the window title');
  await press('Control+S', 'aux');
  await waitFor(() => readFileSync(sampleFile, 'utf8').includes('// from the window'), 5000, 'the save from the window');

  const closed = aux.waitForEvent('close');
  await aux.locator('.icon-move-back').click();
  await closed;
  await waitFor(async () => (await contentTabs().count()) === 1, 5000, 'the tab back in the pane');
  await waitFor(async () => (await editorText()).includes('from the window'), 5000, 'the editor back in the pane');
  return `${colors} token colors in the window`;
});

await step("closing a tab's own window closes the tab", async () => {
  const opened = app.waitForEvent('window');
  await page.locator('#content-pane .icon-pop-out').click();
  const aux = await opened;
  await aux.locator('.aux-body .monaco-editor').waitFor({ timeout: 10_000 });
  const closed = aux.waitForEvent('close');
  // Like the window's close button: the page may object (unsaved changes), then closes itself.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL() === 'about:blank')
      ?.close(),
  );
  await closed;
  await waitFor(async () => (await contentTabs().count()) === 0, 5000, 'the tab to be gone');
});

await step('after an extension host crash and restart, open files come back with unsaved changes', async () => {
  await press('Control+P');
  await page.locator('.quick-input-filter').fill('sample.ts');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'sample.ts in the list');
  await page.locator('.quick-input-filter').press('Enter');
  await waitFor(async () => (await editorText()).includes('answer'), 10_000, 'sample.ts in the pane');
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// survives the crash');
  await waitFor(async () => (await page.locator('#content-pane .content-tab.dirty').count()) === 1, 5000, 'the dirty tab');

  const killed = await app.evaluate(({ app: electronApp }) => {
    const host = electronApp.getAppMetrics().find((metric) => metric.name === 'vilaus extension host');
    if (host) process.kill(host.pid);
    return host !== undefined;
  });
  if (!killed) throw new Error('extension host process not found');
  const restart = page.locator('.banner-error .button');
  await restart.waitFor({ timeout: 15_000 });
  await restart.click();
  await waitFor(async () => (await page.locator('#content-pane .content-tab.dirty').count()) === 1, 30_000, 'the file back, dirty');
  await waitFor(async () => (await editorText()).includes('survives the crash'), 5000, 'the unsaved text back');
  if (readFileSync(sampleFile, 'utf8').includes('survives the crash')) throw new Error('the unsaved text reached the disk');
  // Leave it saved and closed for the next steps.
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  await press('Control+S');
  await waitFor(async () => (await page.locator('#content-pane .content-tab.dirty').count()) === 0, 5000, 'the save');
  await press('Control+W');
  await waitFor(async () => (await contentTabs().count()) === 0, 5000, 'the tab to close');
});

await step('the title bar button toggles the empty content pane', async () => {
  await page.locator('.icon-content-pane').click();
  await waitFor(() => page.locator('#content-pane').isVisible(), 5000, 'the pane to show');
  await page.locator('.icon-content-pane').click();
  await waitFor(() => page.locator('#content-pane').isHidden(), 5000, 'the pane to hide');
});

// ---- settings ------------------------------------------------------------------------------

const readSettings = () => JSON.parse(readFileSync(settingsFile, 'utf8'));
const settingRow = (key) => page.locator(`.settings-dialog .setting-item[data-key="${key}"]`);

await step("Keep Forever sets Claude Code's cleanupPeriodDays when it is not set; turned off, it takes it out", async () => {
  // This instance's Claude Code folder is its sessions folder's parent (VILAUS_SESSIONS_DIR).
  const claudeSettings = path.join(path.dirname(sessionsDir), 'settings.json');
  const period = () => (existsSync(claudeSettings) ? JSON.parse(readFileSync(claudeSettings, 'utf8')).cleanupPeriodDays : undefined);
  await waitFor(() => period() === 36500, 10_000, 'the period set at the start');
  writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), 'vilaus.sessions.keepForever': false }, null, 2), 'utf8');
  await waitFor(() => period() === undefined, 10_000, 'the period taken out');
  const { 'vilaus.sessions.keepForever': _keep, ...rest } = readSettings();
  writeFileSync(settingsFile, JSON.stringify(rest, null, 2), 'utf8');
  await waitFor(() => period() === 36500, 10_000, 'the period set again');
  // A period of the user's own stays.
  writeFileSync(claudeSettings, JSON.stringify({ cleanupPeriodDays: 90 }), 'utf8');
  writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), 'vilaus.sessions.keepForever': false }, null, 2), 'utf8');
  await page.waitForTimeout(1000);
  if (period() !== 90) throw new Error(`the user's own period: ${period()}`);
  writeFileSync(settingsFile, JSON.stringify(rest, null, 2), 'utf8');
  return 'set at the start, taken out when off, set again when on; a value of the user left alone';
});

await step('Ctrl+, opens the settings panel; Editor: Font Size applies to the editor and resets', async () => {
  await press('Control+,');
  await page.locator('.settings-dialog .settings-editor').waitFor({ timeout: 10_000 });
  await page.locator('.settings-dialog .settings-search').fill('font size');
  await waitFor(() => settingRow('editor.fontSize').isVisible(), 5000, 'the Editor: Font Size row');
  if (await settingRow('editor.minimap.enabled').isVisible()) throw new Error('search did not filter');
  // The extension's settings are listed, except those for VS Code integration vilaus lacks.
  await page.locator('.settings-dialog .settings-search').fill('');
  await waitFor(async () => (await settingRow('claudeCode.useCtrlEnterToSend').count()) === 1, 10_000, "the extension's settings");
  if ((await settingRow('claudeCode.useTerminal').count()) !== 0) throw new Error('claudeCode.useTerminal is listed');
  await page.screenshot({ path: path.join(runDir, 'settings.png') });

  await settingRow('editor.fontSize').locator('.setting-input').fill('20');
  await waitFor(() => readSettings()['editor.fontSize'] === 20, 5000, 'editor.fontSize in settings.json');
  await waitFor(() => settingRow('editor.fontSize').evaluate((row) => row.classList.contains('modified')), 5000, 'the modified mark');

  await press('Control+P');
  await page.locator('.quick-input-filter').fill('sample.ts');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'sample.ts in the list');
  await page.locator('.quick-input-filter').press('Enter');
  const fontSize = await waitFor(
    async () => {
      const lines = page.locator('#content-pane .content-editor:not([hidden]) .view-lines');
      const size = (await lines.count()) ? await lines.evaluate((element) => getComputedStyle(element).fontSize) : '';
      return size === '20px' ? size : undefined;
    },
    10_000,
    'the editor at 20px',
  );

  // The settings panel stayed open over the editor.
  await settingRow('editor.fontSize').hover();
  await settingRow('editor.fontSize').locator('.setting-reset').click();
  await waitFor(() => readSettings()['editor.fontSize'] === undefined, 5000, 'editor.fontSize removed');
  return `editor ${fontSize}`;
});

await step('settings.json opens in the editor beside the default settings, validated against the settings schema', async () => {
  const original = readFileSync(settingsFile, 'utf8');
  const withError = { ...JSON.parse(original), 'editor.tabSize': 'wide' };
  writeFileSync(settingsFile, JSON.stringify(withError, null, 2), 'utf8');
  await press('Control+,');
  await page.locator('.settings-dialog .settings-open-json').click();
  await waitFor(async () => (await page.locator('.settings-dialog').count()) === 0, 5000, 'the settings panel to step aside');
  await waitFor(
    async () => (await page.locator('#content-pane .content-tab.active .tab-label').innerText()) === 'settings.json',
    10_000,
    'the settings.json tab',
  );
  // The JSON language service runs in its worker; its warning shows as a squiggle.
  await waitFor(
    async () => (await page.locator('#content-pane .content-editor:not([hidden]) :is(.squiggly-warning, .squiggly-error)').count()) > 0,
    15_000,
    'the schema warning on "wide"',
  );
  // Beside the defaults, read only, as VS Code can show it; they hide and show again.
  const shown = (selector) => page.locator(`#content-pane .content-editor:not([hidden]) ${selector}`);
  await waitFor(async () => (await shown('.defaults-split-header').count()) === 2, 10_000, 'settings.json beside the defaults');
  await waitFor(
    async () => (await shown('.defaults-split-side .view-lines').innerText()).includes('{'),
    15_000,
    'the defaults on the left',
  );
  // The content pane is widened for the two columns, and back to its own width without them.
  const paneWidth = () => page.locator('#content-pane').evaluate((element) => element.getBoundingClientRect().width);
  const wide = await paneWidth();
  await shown('.defaults-split-header .button').click();
  await waitFor(() => shown('.defaults-split-side').isHidden(), 5000, 'the defaults to hide');
  const own = await paneWidth();
  if (own < 1000 && !(wide > own)) throw new Error(`the pane is ${wide}px with the defaults, ${own}px without`);
  await shown('.defaults-split-header .button').click();
  await waitFor(() => shown('.defaults-split-side').isVisible(), 5000, 'the defaults to show again');
  await waitFor(async () => (await paneWidth()) === wide, 5000, 'the pane wide again');
  await page.screenshot({ path: path.join(runDir, 'settings-json.png') });
  // Ctrl+S saves the file on the right, also with the focus in the defaults on the left.
  await shown('.defaults-split-main .monaco-editor .view-lines').click({ position: { x: 30, y: 8 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// saved with Ctrl+S');
  await waitFor(async () => (await page.locator('#content-pane .content-tab.dirty').count()) === 1, 5000, 'the dirty marker');
  await shown('.defaults-split-side .monaco-editor .view-lines').click({ position: { x: 30, y: 8 } });
  await press('Control+S');
  await waitFor(() => readFileSync(settingsFile, 'utf8').includes('// saved with Ctrl+S'), 5000, 'settings.json saved');
  await waitFor(async () => (await page.locator('#content-pane .content-tab.dirty').count()) === 0, 5000, 'the tab clean');
  writeFileSync(settingsFile, original, 'utf8');
  await waitFor(async () => !(await editorText()).includes('"wide"'), 10_000, 'the file back as it was');
  // Close settings.json and sample.ts.
  for (let i = 0; i < 3 && (await contentTabs().count()) > 0; i++) {
    await page.locator('#content-pane .content-tab.active .tab-close').click();
    await page.waitForTimeout(200);
  }
});

await step('Diff Editor: Font Size applies to diffs only', async () => {
  writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), 'diffEditor.fontSize': 18 }, null, 2), 'utf8');
  await press('Control+P');
  await page.locator('.quick-input-filter').fill('sample.ts');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'sample.ts in the list');
  await page.locator('.quick-input-filter').press('Enter');
  await waitFor(async () => (await editorText()).includes('answer'), 10_000, 'sample.ts in the pane');
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// diff font\n');
  await press('Control+Shift+P');
  await page.locator('.quick-input-filter').fill('>Compare Active File with Saved');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) === 1, 5000, 'the command');
  await page.locator('.quick-input-filter').press('Enter');
  const diffSize = await waitFor(
    async () => {
      const lines = page.locator('#content-pane .content-editor:not([hidden]) .monaco-diff-editor .view-lines');
      const size = (await lines.count()) ? await lines.first().evaluate((element) => getComputedStyle(element).fontSize) : '';
      return size === '18px' ? size : undefined;
    },
    10_000,
    'the diff at 18px',
  );
  // Back on the file: the editor keeps the editor font size.
  await press('Control+W');
  await waitFor(async () => (await contentTabs().count()) === 1, 5000, 'the diff tab to close');
  const editorSize = await page
    .locator('#content-pane .content-editor:not([hidden]) .view-lines')
    .evaluate((element) => getComputedStyle(element).fontSize);
  if (editorSize === '18px') throw new Error('the editor took the diff font size');
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  // Typing and Enter are separate undo steps.
  await waitFor(
    async () => {
      await page.keyboard.press('Control+Z');
      return (await page.locator('#content-pane .content-tab.dirty').count()) === 0;
    },
    5000,
    'the file clean again',
  );
  await press('Control+W');
  await waitFor(async () => (await contentTabs().count()) === 0, 5000, 'the tab to close');
  const { 'diffEditor.fontSize': _removed, ...rest } = readSettings();
  writeFileSync(settingsFile, JSON.stringify(rest, null, 2), 'utf8');
  return `diff ${diffSize}, editor ${editorSize}`;
});

await step("File Explorer's context menu: the switch in the settings adds the entries and removes them", async () => {
  const registered = () => {
    try {
      execFileSync(reg, ['query', `${env.VILAUS_REGISTRY_ROOT}\\Directory\\shell\\Vilausity\\command`, '/ve'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  };
  await press('Control+,');
  await page.locator('.settings-dialog .settings-editor').waitFor({ timeout: 10_000 });
  await page.locator('.settings-dialog .settings-search').fill('context menu');
  const widget = page.locator('.settings-dialog .settings-widget[data-widget="explorerMenu.switch"]');
  await widget.waitFor({ timeout: 5000 });
  const box = widget.locator('.setting-checkbox');
  await waitFor(async () => !(await box.isDisabled()), 5000, 'the switch to know the state');
  if ((await box.isChecked()) || registered()) throw new Error('on before it was turned on');
  await box.click();
  await waitFor(async () => (await box.isChecked()) && !(await box.isDisabled()) && registered(), 10_000, 'the entries');
  await box.click();
  await waitFor(async () => !(await box.isChecked()) && !(await box.isDisabled()) && !registered(), 10_000, 'the entries gone');
  await page.locator('.settings-dialog .settings-search').fill('');
  await page.keyboard.press('Escape');
  await waitFor(async () => (await page.locator('.settings-dialog').count()) === 0, 5000, 'the settings panel to close');
  // The installer's switches do the same and quit, with an instance running or not.
  const cli = (flag) =>
    execFileSync(executable, appArgs('--user-data-dir', dataDir, flag), { cwd: root, env, stdio: 'ignore', timeout: 60_000 });
  cli('--register-context-menu');
  if (!registered()) throw new Error('--register-context-menu added nothing');
  cli('--unregister-context-menu');
  if (registered()) throw new Error('--unregister-context-menu left the entries');
});

await step(
  'keyboard shortcuts: recorded keys replace the default in keybindings.json and work; reset brings it back; the file edited by hand shows',
  async () => {
    const keybindingsFile = path.join(dataDir, 'keybindings.json');
    const search = page.locator('.settings-dialog .settings-search');
    const row = page.locator('.settings-dialog .keybinding-row[data-command="sessions.toggleSidebar"]');
    const closeSettings = async () => {
      await search.fill('');
      await page.keyboard.press('Escape');
      await waitFor(async () => (await page.locator('.settings-dialog').count()) === 0, 5000, 'the settings panel to close');
    };
    await press('Control+,');
    await page.locator('.settings-dialog .settings-editor').waitFor({ timeout: 10_000 });
    // The settings search finds the table's rows.
    await search.fill('toggle session list');
    await row.waitFor({ timeout: 5000 });
    if (await page.locator('.settings-dialog .keybinding-row[data-command="window.zoomIn"]').first().isVisible())
      throw new Error('the search did not filter the table');
    await row.dblclick();
    const recorder = page.locator('.keybinding-recorder');
    await recorder.waitFor({ timeout: 5000 });
    // Main lets the keys through to the recorder (Ctrl+Shift+P would open the palette), which names what has them.
    await press('Control+Shift+P');
    await waitFor(async () => (await recorder.innerText()).includes('Also bound to: Show All Commands'), 5000, 'the conflict');
    await press('Control+Alt+B');
    await press('Enter');
    const written = () => (existsSync(keybindingsFile) ? readFileSync(keybindingsFile, 'utf8') : '');
    await waitFor(() => written().includes('"ctrl+alt+b"') && written().includes('"-sessions.toggleSidebar"'), 5000, 'keybindings.json');
    await waitFor(async () => (await row.locator('.keybinding-source-text').innerText()) === 'User', 5000, 'the row from keybindings.json');
    await closeSettings();
    await press('Control+B');
    await page.waitForTimeout(300);
    if (await page.locator('#sidebar').isHidden()) throw new Error('Ctrl+B still toggles the session list');
    await press('Control+Alt+B');
    await waitFor(() => page.locator('#sidebar').isHidden(), 5000, 'Ctrl+Alt+B to hide the session list');
    await press('Control+Alt+B');
    await waitFor(() => page.locator('#sidebar').isVisible(), 5000, 'the session list back');

    // Reset: both entries go, the default is back.
    await press('Control+,');
    await search.fill('toggle session list');
    await row.hover();
    await row.locator('.icon-discard').click();
    await waitFor(() => !written().includes('sessions.toggleSidebar'), 5000, 'the entries to go');
    await waitFor(async () => (await row.locator('.keybinding-source-text').innerText()) === 'Default', 5000, 'the default row');
    // By hand: a command that had no keybinding gets one.
    writeFileSync(keybindingsFile, '// by hand\n[{ "key": "ctrl+alt+j", "command": "settings.openJson" }]\n');
    await search.fill('settings json');
    const added = page.locator('.settings-dialog .keybinding-row[data-command="settings.openJson"]');
    await waitFor(
      async () => (await added.locator('.keybinding-key').innerText()).replace(/\s/g, '') === 'Ctrl+Alt+J',
      5000,
      'the keybinding written by hand',
    );
    writeFileSync(keybindingsFile, '[]\n');
    await waitFor(async () => (await added.locator('.keybinding-key').innerText()).trim() === '', 5000, 'the keybinding gone again');
    await closeSettings();
    await press('Control+B');
    await waitFor(() => page.locator('#sidebar').isHidden(), 5000, 'Ctrl+B to toggle again');
    await press('Control+B');
    await waitFor(() => page.locator('#sidebar').isVisible(), 5000, 'the session list back');

    // keybindings.json beside the default keybindings: Ctrl+S saves it.
    await runCommand('Open Keyboard Shortcuts (JSON)');
    await waitFor(
      async () => (await page.locator('#content-pane .content-tab.active .tab-label').innerText()) === 'keybindings.json',
      10_000,
      'the keybindings.json tab',
    );
    await page
      .locator('#content-pane .content-editor:not([hidden]) .defaults-split-main .monaco-editor .view-lines')
      .click({ position: { x: 30, y: 8 } });
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n// saved with Ctrl+S');
    await press('Control+S');
    await waitFor(() => written().includes('// saved with Ctrl+S'), 5000, 'keybindings.json saved');
    await press('Control+W');
    await waitFor(async () => (await contentTabs().count()) === 0, 5000, 'the keybindings.json tab to close');
    writeFileSync(keybindingsFile, '[]\n');
  },
);

await step(
  'fonts: the UI, the conversation and its code each have their own; the bundled Noto Sans SC loads in webviews; chat.fontSize applies at once',
  async () => {
    const chat = await waitFor(
      async () => {
        for (const frame of webviewFrames()) {
          if (
            (await frame
              .locator('[role="textbox"][aria-label="Message input"]')
              .count()
              .catch(() => 0)) > 0
          )
            return frame;
        }
        return undefined;
      },
      10_000,
      'a conversation page',
    );
    const fonts = () =>
      chat.evaluate(async () => {
        const input = getComputedStyle(document.querySelector('[role="textbox"][aria-label="Message input"]'));
        const button = getComputedStyle(document.querySelector('form button'));
        const root = getComputedStyle(document.documentElement);
        // Loading it goes through the page's CSP (font-src) and the font file's CORS headers.
        const loaded = await document.fonts.load(`${input.fontSize} "Noto Sans SC"`, '中文');
        return {
          input: input.fontFamily,
          inputSize: input.fontSize,
          button: button.fontFamily,
          code: root.getPropertyValue('--vscode-editor-font-family').trim(),
          noto: loaded.filter((face) => face.status === 'loaded').length,
        };
      });
    const before = await fonts();
    if (!before.input.includes('"Noto Sans SC"')) throw new Error(`message input font: ${before.input}`);
    if (before.inputSize !== '14px') throw new Error(`message input size: ${before.inputSize}`);
    if (!before.button.includes('"Microsoft YaHei UI"') || before.button.includes('Noto')) throw new Error(`button font: ${before.button}`);
    if (!before.code.startsWith('Consolas')) throw new Error(`code font: ${before.code}`);
    if (before.noto === 0) throw new Error('Noto Sans SC did not load in the conversation page');
    const shellNoto = await page.evaluate(async () => (await document.fonts.load('14px "Noto Sans SC"', '中文')).length);
    if (shellNoto === 0) throw new Error('Noto Sans SC did not load in the shell');

    writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), 'chat.fontSize': 18 }, null, 2), 'utf8');
    await waitFor(async () => (await fonts()).inputSize === '18px', 10_000, 'the conversation at 18px');
    const { 'chat.fontSize': _removed, ...rest } = readSettings();
    writeFileSync(settingsFile, JSON.stringify(rest, null, 2), 'utf8');
    await waitFor(async () => (await fonts()).inputSize === '14px', 10_000, 'the conversation back at 14px');
    return `input ${before.inputSize}, ${before.noto} Noto Sans SC slice(s) loaded`;
  },
);

await step('settings.json reaches every Monaco option; Default Settings (JSON) lists them all', async () => {
  // Not in the settings editor, only in settings.json.
  writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), 'editor.rulers': [12] }, null, 2), 'utf8');
  await press('Control+P');
  await page.locator('.quick-input-filter').fill('sample.ts');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'sample.ts in the list');
  await page.locator('.quick-input-filter').press('Enter');
  await waitFor(
    async () => (await page.locator('#content-pane .content-editor:not([hidden]) .view-ruler').count()) === 1,
    10_000,
    'the ruler',
  );

  await press('Control+,');
  await page.locator('.settings-dialog .settings-open-defaults').click();
  await waitFor(
    async () => (await page.locator('#content-pane .content-tab.active .tab-label').innerText()) === 'Default Settings',
    10_000,
    'the Default Settings tab',
  );
  await waitFor(async () => (await editorText()).includes('Every setting with its default value'), 10_000, 'the default settings text');
  await page.screenshot({ path: path.join(runDir, 'default-settings.png') });
  // Monaco renders only the visible lines of the long view: find an option only Monaco declares.
  // Ctrl+F goes through the main process, which used to reach only text and diff panes.
  await page.locator('#content-pane .content-editor:not([hidden]) .view-lines').click();
  await press('Control+F');
  await page.keyboard.type('"editor.rulers"');
  await waitFor(async () => (await editorText()).includes('"editor.rulers": ['), 5000, 'editor.rulers found in the defaults');
  await page.keyboard.press('Escape');

  // Like any tab, it moves into its own window (scrolled where it was) and back.
  const opened = app.waitForEvent('window');
  await page.locator('#content-pane .icon-pop-out').click();
  const aux = await opened;
  const auxLines = aux.locator('.aux-body .view-lines');
  await waitFor(
    async () => (await auxLines.count()) > 0 && (await auxLines.innerText()).includes('"editor.rulers"'),
    10_000,
    'the defaults in the new window, scrolled',
  );
  const closed = aux.waitForEvent('close');
  await aux.locator('.icon-move-back').click();
  await closed;
  await waitFor(
    async () => (await page.locator('#content-pane .content-tab.active .tab-label').innerText()) === 'Default Settings',
    5000,
    'the tab back in the pane',
  );

  const { 'editor.rulers': _removed, ...rest } = readSettings();
  writeFileSync(settingsFile, JSON.stringify(rest, null, 2), 'utf8');
  for (let i = 0; i < 3 && (await contentTabs().count()) > 0; i++) {
    await page.locator('#content-pane .content-tab.active .tab-close').click();
    await page.waitForTimeout(200);
  }
  if ((await contentTabs().count()) > 0) throw new Error('tabs left open');
  return 'ruler shown; editor.rulers found in the defaults; moved to a window and back';
});

await step('About shows the versions and the latest release from GitHub (a local stand-in)', async () => {
  // Main's links and clipboard record instead of opening and copying for real.
  await app.evaluate(({ shell, clipboard }) => {
    globalThis.vilausAboutDone = [];
    globalThis.vilausAboutOpen = shell.openExternal.bind(shell);
    globalThis.vilausAboutClipboard = clipboard.writeText.bind(clipboard);
    shell.openExternal = async (url) => {
      globalThis.vilausAboutDone.push(`open ${url}`);
    };
    clipboard.writeText = (text) => globalThis.vilausAboutDone.push(`copy ${text}`);
  });
  try {
    await press('Control+,');
    const search = page.locator('.settings-dialog .settings-search');
    await search.fill('about');
    const widget = page.locator('.settings-dialog .settings-widget[data-widget="about.info"]');
    await widget.waitFor({ timeout: 10_000 });
    const value = (name) => widget.locator(`[data-about="${name}"]`);
    const release = value('release');

    const appVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if ((await value('app').innerText()).trim() !== appVersion) {
      throw new Error(`Vilausity reads "${await value('app').innerText()}", not ${appVersion}`);
    }
    const extensionVersion = (await value('extension').innerText()).trim();
    if (!/^Claude Code extension \d+\.\d+\.\d+/.test(extensionVersion))
      throw new Error(`the extension version reads "${extensionVersion}"`);
    // What the app runs on is only in the copied text.
    const shown = await widget.innerText();
    if (/Electron|Chromium|Node/.test(shown)) throw new Error(`the section shows the runtime: ${shown}`);

    // The stand-in said no: the section says so and offers Retry.
    await waitFor(async () => (await release.getAttribute('data-state')) === 'failed', 10_000, 'the failed latest release');
    if (!(await release.innerText()).includes('Could not check for a newer version')) {
      throw new Error(`the failure reads "${await release.innerText()}"`);
    }
    if (!(await value('retry').isVisible())) throw new Error('Retry is hidden after a failure');

    releasesRespond = true;
    await value('retry').click();
    await waitFor(async () => (await release.getAttribute('data-state')) === 'ready', 10_000, 'the latest release after Retry');
    const ready = await release.innerText();
    if (!ready.includes('0.9.5-beta.1')) throw new Error(`the latest release reads "${ready}"`);
    if (!ready.includes('A newer version is available: 0.9.5-beta.1')) throw new Error(`no newer-version note in "${ready}"`);

    await value('newer').click();
    await value('repository').click();
    await value('releases').click();
    await value('copy').click();
    await waitFor(
      async () => (await app.evaluate(() => globalThis.vilausAboutDone?.length ?? 0)) >= 4,
      5000,
      'the links and the copied text',
    );
    const done = await app.evaluate(() => globalThis.vilausAboutDone);
    const repository = 'https://github.com/Teabie666/vilausity-claude-code-gui-shell';
    if (!done.includes(`open ${repository}`)) throw new Error(`GitHub Repository opened ${JSON.stringify(done)}`);
    if (!done.includes(`open ${repository}/releases`)) throw new Error(`Releases opened ${JSON.stringify(done)}`);
    if (!done.includes('open https://example.invalid/0.9.5-beta.1')) throw new Error(`the newer release opened ${JSON.stringify(done)}`);
    const copied = done.find((entry) => entry.startsWith('copy ')) ?? '';
    for (const expected of [`Vilausity: ${appVersion}`, 'Claude Code extension: ', 'Electron: ', 'Chromium: ', 'Node.js: ', 'OS: ']) {
      if (!copied.includes(expected)) throw new Error(`the copied text lacks "${expected}": ${copied}`);
    }
    if (releasesRequests.length === 0) throw new Error('the local GitHub stand-in was never asked');

    await search.fill('');
    await page.keyboard.press('Escape');
    await waitFor(async () => (await page.locator('.settings-dialog').count()) === 0, 5000, 'the settings panel to close');
    return `${extensionVersion}; ${ready.replace(/\n/g, ' ')}`;
  } finally {
    await app.evaluate(({ shell, clipboard }) => {
      shell.openExternal = globalThis.vilausAboutOpen;
      clipboard.writeText = globalThis.vilausAboutClipboard;
    });
  }
});

// ---- M4: windows ----------------------------------------------------------------------------

const second = path.join(runDir, 'second');
const third = path.join(runDir, 'third');
mkdirSync(second, { recursive: true });
mkdirSync(third, { recursive: true });
let secondPage;

await step('a folder opens in a window of its own; opening it again brings that window forward', async () => {
  const opened = app.waitForEvent('window');
  await openFolder(page, second, true);
  secondPage = await opened;
  await waitFor(async () => showsFolder(await secondPage.title(), second), 30_000, 'the new window');
  await waitFor(
    () => secondPage.frames().filter((f) => f.url().startsWith('ccw://wv')).length >= 2,
    30_000,
    "the new window's conversation and session list",
  );
  await openFolder(page, second, true);
  await page.waitForTimeout(1000);
  if (shellPages().length !== 2) throw new Error(`${shellPages().length} windows`);
  const button = await secondPage.locator('.search-box-label').innerText();
  if (button !== 'Workspace: second') throw new Error(`the search box says ${button}`);
  return `${shellPages().length} windows`;
});

await step("Ctrl+R opens a recent folder in place of this window's; its conversations come back with it", async () => {
  // The third folder joins the recent folders: opened in a window that Ctrl+Shift+W closes.
  const opened = app.waitForEvent('window');
  await openFolder(page, third, true);
  const thirdPage = await opened;
  await waitFor(async () => showsFolder(await thirdPage.title(), third), 30_000, 'the third window');
  const closed = thirdPage.waitForEvent('close');
  await press('Control+Shift+W', third);
  await closed;

  const tabs = () => secondPage.locator('#tabs .tab').count();
  await press('Control+N', second);
  await waitFor(async () => (await tabs()) === 2, 20_000, 'two conversations in the second window');
  // Let the panels save their state (PanelRestore debounces writes).
  await secondPage.waitForTimeout(1500);

  const openRecent = async (from, name) => {
    await press('Control+R', from);
    const filter = secondPage.locator('.quick-input-filter');
    await filter.waitFor({ timeout: 5000 });
    const labels = await secondPage.locator('.quick-input-item .quick-input-label').allInnerTexts();
    await filter.fill(name);
    await filter.press('Enter');
    await secondPage.locator('.modal .button', { hasText: /^Open$/ }).click();
    return labels;
  };
  const labels = await openRecent(second, 'third');
  for (const expected of ['Open Folder...', 'third', path.basename(workspace)]) {
    if (!labels.includes(expected)) throw new Error(`the list was ${labels.join(' | ')}`);
  }
  await waitFor(async () => showsFolder(await secondPage.title(), third), 30_000, 'the window to show the third folder');
  await waitFor(async () => (await tabs()) === 1, 30_000, "the third folder's own conversation");
  // The folder switched to is the most recent in the other window's lists: the search's, and Ctrl+R's.
  await page.locator('.search-box-open').click();
  await page.locator('.quick-input-separator', { hasText: 'Folders' }).waitFor({ timeout: 5000 });
  const searchFolders = await page.evaluate(() => {
    const separator = [...document.querySelectorAll('.quick-input-separator')].find((element) => element.textContent === 'Folders');
    const names = [];
    for (let row = separator?.nextElementSibling; row?.classList.contains('quick-input-item'); row = row.nextElementSibling) {
      names.push(row.querySelector('.quick-input-label').textContent);
    }
    return names;
  });
  await page.locator('.quick-input-filter').press('Escape');
  await waitFor(async () => (await page.locator('.quick-input-filter').count()) === 0, 3000, 'the search to close');
  await press('Control+R');
  await page.locator('.quick-input-filter').waitFor({ timeout: 5000 });
  const pickerFolders = await page.locator('.quick-input-item .quick-input-label').allInnerTexts();
  await page.locator('.quick-input-filter').press('Escape');
  await waitFor(async () => (await page.locator('.quick-input-filter').count()) === 0, 3000, 'Ctrl+R to close');
  if (searchFolders[0] !== 'third' || !pickerFolders.includes('third')) {
    throw new Error(`the search lists ${searchFolders.join(', ')}; Ctrl+R lists ${pickerFolders.join(', ')}`);
  }

  await openRecent(third, 'second');
  await waitFor(async () => showsFolder(await secondPage.title(), second), 30_000, 'the second folder again');
  await waitFor(async () => (await tabs()) === 2, 30_000, 'its two conversations to come back');
  return labels.join(' | ');
});

await step('Ctrl+Shift+W closes a window; the others stay', async () => {
  const closed = secondPage.waitForEvent('close');
  await press('Control+Shift+W', second);
  await closed;
  await page.waitForTimeout(500);
  if (shellPages().length !== 1) throw new Error(`${shellPages().length} windows`);
  // The test workspace's window still works.
  await press('Control+B');
  await waitFor(() => page.locator('#sidebar').isHidden(), 5000, 'the sidebar to hide');
  await press('Control+B');
  await waitFor(() => page.locator('#sidebar').isVisible(), 5000, 'the sidebar to show');
});

/** Starts the app again with the same data folder, as a second start would; resolves when that process exits. */
const startAgain = (...extra) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, appArgs('--user-data-dir', dataDir, '--secondary-display', ...extra), {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
  });

await step('--version prints the versions and exits', async () => {
  const { code, out } = await startAgain('--version');
  if (code !== 0 || !out.includes('Vilausity') || !out.includes('Claude Code')) throw new Error(`exit ${code}: ${out}`);
  return out.trim().split(/\r?\n/)[0];
});

await step('a second start hands its folder and --goto to the running instance', async () => {
  const opened = app.waitForEvent('window');
  const { code } = await startAgain('--folder', third);
  if (code !== 0) throw new Error(`the second start exited with ${code}`);
  const thirdPage = await opened;
  await waitFor(async () => showsFolder(await thirdPage.title(), third), 30_000, 'a window for the folder');
  const notes = path.join(third, 'notes.txt');
  writeFileSync(notes, 'one\ntwo\nthree\n', 'utf8');
  await startAgain('--goto', `${notes}:2`);
  const active = thirdPage.locator('#content-pane .content-tab.active .tab-label');
  await waitFor(async () => (await active.innerText().catch(() => '')) === 'notes.txt', 30_000, 'notes.txt in that window');
  const closed = thirdPage.waitForEvent('close');
  await press('Control+Shift+W', third);
  await closed;
  return `${shellPages().length} window left`;
});

await step('--prompt from a second start opens a conversation; a vilaus:// link asks first', async () => {
  const before = await tabCount();
  await startAgain('--prompt', 'hello from the command line');
  await waitFor(async () => (await tabCount()) === before + 1, 30_000, 'a conversation for the prompt');
  const frame = await waitFor(conversationFrame, 10_000, 'the new conversation');
  const input = frame.locator('[role="textbox"][aria-label="Message input"]');
  await waitFor(
    async () => (await input.innerText().catch(() => '')).includes('hello from the command line'),
    20_000,
    'the prompt in its input',
  );

  await startAgain('vilaus://anthropic.claude-code/open?prompt=from%20a%20link');
  const open = page.locator('.modal .button', { hasText: /^Open$/ });
  await open.waitFor({ timeout: 30_000 });
  const message = await page.locator('.modal-message').innerText();
  await open.click();
  await waitFor(async () => (await tabCount()) === before + 2, 30_000, 'a conversation for the link');
  for (let i = 0; i < 2; i++) {
    await press('Control+W');
    await waitFor(async () => (await tabCount()) === before + 1 - i, 10_000, 'the extra conversation to close');
  }
  return message;
});

// ---- M6.5: the local API ----------------------------------------------------------------------

const setSetting = (key, value) => page.evaluate((params) => window.vilausNative.invoke('settings.update', params), { key, value });

/** The local API's event stream: what it has sent so far, by event. */
function openEventStream(api) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${api.url}/events`, { headers: { authorization: `Bearer ${api.token}` } }, (response) => {
      response.setEncoding('utf8');
      let text = '';
      response.on('data', (chunk) => (text += chunk));
      resolve({
        status: response.statusCode,
        events: () =>
          text
            .split('\n\n')
            .map((block) => {
              const name = /^event: (.*)$/m.exec(block)?.[1];
              const data = /^data: (.*)$/m.exec(block)?.[1];
              return name === undefined ? undefined : { name, data: JSON.parse(data ?? 'null') };
            })
            .filter((event) => event !== undefined),
        close: () => request.destroy(),
      });
    });
    request.on('error', reject);
    request.end();
  });
}

await step(
  'the local API: off by default; on, it takes the key only, lists the window, opens a file and a conversation, runs a command and streams the changes',
  async () => {
    const apiFile = path.join(dataDir, 'api.json');
    if (existsSync(apiFile)) throw new Error('api.json before the API was turned on');
    await setSetting('vilaus.api.enabled', true);
    const api = await waitFor(() => existsSync(apiFile) && JSON.parse(readFileSync(apiFile, 'utf8')), 10_000, 'api.json');
    const call = async (name, params, { method = 'POST', headers = {} } = {}) => {
      const init = { method, headers: { authorization: `Bearer ${api.token}`, ...headers } };
      const response = await fetch(`${api.url}/${name}`, method === 'POST' ? { ...init, body: JSON.stringify(params ?? {}) } : init);
      return { status: response.status, body: await response.json() };
    };
    // Only with the key, and never from a web page.
    if ((await fetch(`${api.url}/windows.list`)).status !== 401) throw new Error('answered without the key');
    const fromPage = await call('windows.list', undefined, { method: 'GET', headers: { origin: 'https://example.com' } });
    if (fromPage.status !== 403) throw new Error(`a web page's request: ${fromPage.status}`);
    const listing = await (await fetch(api.url, { headers: { authorization: `Bearer ${api.token}` } })).json();
    const names = listing.operations.map((operation) => operation.name);
    for (const name of ['windows.list', 'conversations.open', 'files.open', 'commands.run']) {
      if (!names.includes(name)) throw new Error(`the listing has ${names.join(', ')}`);
    }
    if (listing.allowSend !== false) throw new Error('sending is on by default');

    const stream = await openEventStream(api);
    try {
      const greeting = await waitFor(() => stream.events().find((event) => event.name === 'windows'), 5000, 'the windows event');
      // The window's own conversation, once its page has told the extension of it.
      const windows = await waitFor(
        async () => {
          const list = (await call('windows.list', undefined, { method: 'GET' })).body;
          return list[0]?.conversations.length > 0 && list;
        },
        20_000,
        "the window's conversation in windows.list",
      );
      if (windows.length !== 1 || windows[0].folder !== workspace || !windows[0].active || greeting.data[0].id !== windows[0].id)
        throw new Error(`windows: ${JSON.stringify(windows)}`);

      // A new conversation with a prompt: a tab, the prompt in its input, an event for it.
      const before = await tabCount();
      const known = new Set(windows[0].conversations.map((conversation) => conversation.sessionId));
      const opened = await call('conversations.open', { prompt: 'from the local API' });
      if (opened.status !== 200 || opened.body.window !== windows[0].id) throw new Error(`conversations.open: ${JSON.stringify(opened)}`);
      await waitFor(async () => (await tabCount()) === before + 1, 30_000, 'a conversation for the prompt');
      const frame = await waitFor(conversationFrame, 10_000, 'the new conversation');
      const input = frame.locator('[role="textbox"][aria-label="Message input"]');
      await waitFor(
        async () => (await input.innerText().catch(() => '')).includes('from the local API'),
        20_000,
        'the prompt in its input',
      );
      const came = await waitFor(
        () => stream.events().find((event) => event.name === 'conversation.state' && !known.has(event.data.sessionId)),
        20_000,
        'an event for the new conversation',
      );
      await press('Control+W');
      await waitFor(
        () =>
          stream
            .events()
            .some(
              (event) =>
                event.name === 'conversation.state' && event.data.sessionId === came.data.sessionId && event.data.state === 'closed',
            ),
        20_000,
        'the closed conversation',
      ).catch(async (error) => {
        throw new Error(`${error.message}; ${await tabCount()} tabs; events ${JSON.stringify(stream.events().slice(-3))}`);
      });

      // A file, in the editor of the window whose folder holds it.
      const note = path.join(workspace, 'api-note.txt');
      writeFileSync(note, 'opened by a program\n', 'utf8');
      const file = await call('files.open', { path: note, line: 1 });
      if (file.status !== 200) throw new Error(`files.open: ${JSON.stringify(file)}`);
      const tab = page.locator('#content-pane .content-tab', { hasText: 'api-note.txt' });
      await tab.waitFor({ timeout: 20_000 });
      await tab.click({ button: 'middle' });
      if ((await call('files.open', { path: 'api-note.txt' })).status !== 400) throw new Error('a relative path was taken');

      // A command, as the palette runs it.
      const commands = (await call('commands.list', undefined, { method: 'GET' })).body;
      if (!commands.some((command) => command.id === 'sessions.toggleSidebar')) throw new Error(`${commands.length} commands, no toggle`);
      await call('commands.run', { command: 'sessions.toggleSidebar' });
      await waitFor(() => page.locator('#sidebar').isHidden(), 5000, 'the sidebar to hide');
      await call('commands.run', { command: 'sessions.toggleSidebar' });
      await waitFor(() => page.locator('#sidebar').isVisible(), 5000, 'the sidebar to show');
      if ((await call('commands.run', { command: 'no.such.command' })).status !== 404) throw new Error('an unknown command ran');
    } finally {
      stream.close();
    }

    // The settings say where it runs; off, it stops; on again, the key is the same.
    await press('Control+,');
    await page.locator('.settings-dialog .settings-search').fill('local api');
    const widget = page.locator('.settings-dialog .settings-widget[data-widget="localApi.status"]');
    await waitFor(async () => (await widget.innerText()).includes(`Running at ${api.url}`), 5000, 'the status in the settings');
    await setSetting('vilaus.api.enabled', false);
    await waitFor(async () => (await widget.innerText()).includes('Off'), 5000, 'the status off');
    await page.locator('.settings-dialog .settings-search').fill('');
    await page.keyboard.press('Escape');
    if (
      await fetch(api.url).then(
        () => true,
        () => false,
      )
    )
      throw new Error('still answering when off');
    await setSetting('vilaus.api.enabled', true);
    const again = await waitFor(
      async () => {
        const saved = JSON.parse(readFileSync(apiFile, 'utf8'));
        const answer = await fetch(saved.url, { headers: { authorization: `Bearer ${saved.token}` } }).catch(() => undefined);
        return answer?.status === 200 && saved;
      },
      10_000,
      'the API on again',
    );
    if (again.token !== api.token) throw new Error('a new key after a restart of the API');
    await setSetting('vilaus.api.enabled', undefined);
    return `${listing.operations.length} operations at ${api.url}`;
  },
);

await step(
  'the local API sends a prompt as Enter does, in a new conversation and in its session again, only with sending allowed, never over typed text',
  async () => {
    const mock = await startMockApi();
    const before = await tabCount();
    try {
      await page.evaluate(async (port) => {
        await window.vilausNative.invoke('providers.save', {
          provider: {
            id: 'mock-send',
            name: 'Mock send',
            type: 'compatible',
            baseUrl: `http://127.0.0.1:${port}`,
            auth: 'bearer',
            models: { main: 'mock-model' },
          },
        });
        await window.vilausNative.invoke('providers.setKey', { id: 'mock-send', key: 'k' });
        await window.vilausNative.invoke('providers.select', { id: 'mock-send' });
      }, mock.port);
      await setSetting('vilaus.api.enabled', true);
      const apiFile = path.join(dataDir, 'api.json');
      const api = await waitFor(
        async () => {
          const saved = JSON.parse(readFileSync(apiFile, 'utf8'));
          const answer = await fetch(saved.url, { headers: { authorization: `Bearer ${saved.token}` } }).catch(() => undefined);
          return answer?.status === 200 && saved;
        },
        10_000,
        'the API',
      );
      const call = async (name, params) => {
        const response = await fetch(`${api.url}/${name}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${api.token}` },
          body: JSON.stringify(params),
        });
        return { status: response.status, body: await response.json() };
      };
      // What the mock API was asked with: the user's last words in each request of the conversation.
      const asked = (text) =>
        mock.requests.some(
          (request) =>
            request.url?.startsWith('/v1/messages') &&
            !request.url.includes('count_tokens') &&
            JSON.stringify(request.body?.messages ?? []).includes(text),
        );

      const refused = await call('conversations.send', { prompt: 'not yet' });
      if (refused.status !== 403) throw new Error(`sent with sending off: ${JSON.stringify(refused)}`);
      await setSetting('vilaus.api.allowSend', true);

      const first = await call('conversations.send', { prompt: 'SEND-ONE from a program' });
      if (first.status !== 200 || typeof first.body.sessionId !== 'string') throw new Error(`first send: ${JSON.stringify(first)}`);
      await waitFor(() => asked('SEND-ONE from a program'), 30_000, 'the mock API to get the first prompt');
      if ((await tabCount()) !== before + 1) throw new Error(`${await tabCount()} tabs after the first send`);
      // Its session again, once the first turn is over: the same tab, no new one.
      const idle = async () =>
        (await call('windows.list', {})).body[0]?.conversations.find((conversation) => conversation.sessionId === first.body.sessionId)
          ?.state === 'idle';
      await waitFor(idle, 30_000, 'the first turn to end');
      const second = await call('conversations.send', { prompt: 'SEND-TWO in the same session', sessionId: first.body.sessionId });
      if (second.status !== 200 || second.body.sessionId !== first.body.sessionId)
        throw new Error(`second send: ${JSON.stringify(second)}`);
      await waitFor(() => asked('SEND-TWO in the same session'), 30_000, 'the mock API to get the second prompt');
      if ((await tabCount()) !== before + 1) throw new Error(`${await tabCount()} tabs after the second send`);

      // Text the user typed stays: nothing is sent over it.
      await waitFor(idle, 30_000, 'the second turn to end');
      const frame = await waitFor(conversationFrame, 10_000, 'the conversation');
      const input = frame.locator('[role="textbox"][aria-label="Message input"]');
      // As if typed: the page's editor takes inserted text like keys.
      await input.evaluate((element) => {
        element.focus();
        document.execCommand('insertText', false, 'half a thought');
      });
      const typed = await call('conversations.send', { prompt: 'SEND-THREE', sessionId: first.body.sessionId });
      if (typed.status !== 409 || typed.body.error !== 'input_not_empty') throw new Error(`over typed text: ${JSON.stringify(typed)}`);
      if (!(await input.innerText()).includes('half a thought') || asked('SEND-THREE')) throw new Error('the typed text was replaced');
      await input.evaluate((element) => {
        element.focus();
        document.execCommand('selectAll');
        document.execCommand('delete');
      });
      return `${mock.requests.length} requests to the mock`;
    } finally {
      // The steps after this one need the subscription and the API off, whatever went wrong here.
      await page
        .evaluate(async () => {
          await window.vilausNative.invoke('providers.select', { id: 'subscription' });
          await window.vilausNative.invoke('providers.remove', { id: 'mock-send' });
        })
        .catch((error) => console.log(`  (cleanup: ${error.message})`));
      await setSetting('vilaus.api.allowSend', undefined);
      await setSetting('vilaus.api.enabled', undefined);
      mock.server.close();
      for (let tries = 0; (await tabCount()) > before && tries < 5; tries++) {
        const count = await tabCount();
        await press('Control+W');
        await waitFor(async () => (await tabCount()) < count, 10_000, 'the tab to close').catch(() => undefined);
      }
    }
  },
);

// ---- M4: API providers ------------------------------------------------------------------------

/**
 * A stand-in for an Anthropic-compatible API on 127.0.0.1: records requests, answers briefly,
 * or with the tool call `toolUse` gives for a request's body (`{name, input}`).
 */
function startMockApi({ toolUse } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      const url = request.url ?? '';
      if (request.method === 'POST' && url.startsWith('/v1/messages/count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (request.method === 'POST' && url.startsWith('/v1/messages')) {
        const message = {
          // Each reply its own id, as an API gives them (usage counts a call once by its id).
          id: `msg_mock_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model: body?.model ?? 'mock',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        const tool = toolUse?.(body);
        const block = tool
          ? { type: 'tool_use', id: `toolu_mock_${requests.length}`, name: tool.name, input: tool.input }
          : { type: 'text', text: 'MOCK-OK' };
        const stopReason = tool ? 'tool_use' : 'end_turn';
        if (body?.stream) {
          // Each event is named after its type.
          const events = [
            { type: 'message_start', message },
            tool
              ? { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } }
              : { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            tool
              ? { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }
              : { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MOCK-OK' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
          ];
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ...message, content: [block], stop_reason: stopReason }));
        }
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not in the mock' } }));
    });
  });
  return listenOnSafePort(server).then((port) => ({ server, requests, port }));
}

/** Waits for the window to reload and show its conversations again; `start` triggers the reload. */
const reloaded = async (start) => {
  await page.evaluate(() => (window.__vilausBeforeReload = true));
  await start();
  await waitFor(
    async () =>
      (await page.evaluate(() => window.__vilausBeforeReload !== true).catch(() => false)) &&
      (await tabCount()) >= 1 &&
      webviewFrames().length >= 2,
    30_000,
    'the window to reload',
  );
};
const reloadWindow = () => reloaded(() => page.evaluate(() => window.vilausNative.invoke('window.reload')));

await step(
  'an API provider: the title bar switches to it, the window takes its accent (the logo and the window icon too), and new Claude processes send its key and model',
  async () => {
    const mock = await startMockApi();
    const accent = (target) =>
      target.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return { line: style.getPropertyValue('--vilaus-accent').trim(), focus: style.getPropertyValue('--vscode-focusBorder').trim() };
      });
    // The title bar's logo, as drawn.
    const logo = () => page.evaluate(() => getComputedStyle(document.querySelector('.titlebar-logo svg')).fill);
    // The window icons main drew in other colors than the app's.
    const iconFiles = () => (existsSync(path.join(dataDir, 'icons')) ? readdirSync(path.join(dataDir, 'icons')) : []);
    // The subscription: Claude's orange; the logo in its own.
    const claude = await accent(page);
    if (claude.line !== '#d97757' || claude.focus !== '#d97757') throw new Error(`subscription accent: ${JSON.stringify(claude)}`);
    if ((await logo()) !== 'rgb(255, 123, 28)') throw new Error(`subscription logo: ${await logo()}`);
    // The setting: a color of one's own, VS Code's own (no line), back to the provider's.
    writeFileSync(
      settingsFile,
      JSON.stringify({ ...readSettings(), 'vilaus.accent': 'custom', 'vilaus.accent.custom': '#00aa00' }, null, 2),
      'utf8',
    );
    await waitFor(async () => (await accent(page)).focus === '#00aa00', 5000, 'the custom accent');
    if ((await logo()) !== 'rgb(0, 170, 0)') throw new Error(`custom logo: ${await logo()}`);
    if (!iconFiles().some((name) => /^logo-[0-9a-f]{6}-[0-9a-f]{8}\.ico$/.test(name)))
      throw new Error(`no window icon drawn: ${iconFiles().join(', ')}`);
    writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), 'vilaus.accent': 'vscode' }, null, 2), 'utf8');
    await waitFor(async () => (await accent(page)).line === 'transparent', 5000, "VS Code's own colors");
    if ((await accent(page)).focus !== '#0078d4') throw new Error(`VS Code's focus border: ${(await accent(page)).focus}`);
    if ((await logo()) !== 'rgb(255, 123, 28)') throw new Error(`logo without an accent: ${await logo()}`);
    const { 'vilaus.accent': _source, 'vilaus.accent.custom': _custom, ...ownSettings } = readSettings();
    writeFileSync(settingsFile, JSON.stringify(ownSettings, null, 2), 'utf8');
    await waitFor(async () => (await accent(page)).line === '#d97757', 5000, "the provider's accent again");
    // What the session list's usage block will add up: calls of the mock's models (no tags: put
    // down to the provider that names the model), one reply written in two lines.
    const call = (id, model, cwd, usage) =>
      JSON.stringify({ type: 'assistant', cwd, timestamp: '2026-10-13T08:00:00.000Z', message: { id, model, usage } });
    writeFileSync(
      path.join(sessionsDir, 'project', '00000000-0000-4000-8000-0000000000a1.jsonl'),
      [1, 2]
        .map(() =>
          call('msg-1', 'mock-model', workspace, { input_tokens: 1_000_000, output_tokens: 500_000, cache_read_input_tokens: 2_000_000 }),
        )
        .join('\n') + '\n',
      'utf8',
    );
    writeFileSync(
      path.join(sessionsDir, 'project', '00000000-0000-4000-8000-0000000000a2.jsonl'),
      [
        call('msg-2', 'mock-model', path.join(runDir, 'elsewhere'), { input_tokens: 1_000_000 }),
        call('msg-3', 'mock-haiku', path.join(runDir, 'elsewhere'), { input_tokens: 1000 }),
      ].join('\n') + '\n',
      'utf8',
    );
    try {
      await page.evaluate(async (port) => {
        await window.vilausNative.invoke('providers.save', {
          provider: {
            id: 'mock',
            name: 'Mock API',
            type: 'compatible',
            baseUrl: `http://127.0.0.1:${port}`,
            auth: 'bearer',
            models: { main: 'mock-model', haiku: 'mock-haiku' },
            color: '#ff0000',
            pricing: { currency: 'CNY', models: { 'mock-model': { input: 2, output: 8, cacheRead: 0.2 } } },
          },
        });
        await window.vilausNative.invoke('providers.setKey', { id: 'mock', key: 'test-key-123' });
      }, mock.port);
      if (readFileSync(path.join(dataDir, 'providers.json'), 'utf8').includes('test-key-123')) {
        throw new Error('providers.json holds the key in clear');
      }

      await page.locator('.titlebar-provider').click();
      const filter = page.locator('.quick-input-filter');
      await filter.waitFor({ timeout: 5000 });
      await filter.fill('Mock API');
      await filter.press('Enter');
      await waitFor(
        async () => (await page.locator('.titlebar-provider-label').innerText()) === 'Mock API',
        5000,
        'the provider in the title bar',
      );
      await waitFor(async () => (await accent(page)).line === '#ff0000', 5000, "the provider's accent line");
      if ((await accent(page)).focus !== '#ff0000') throw new Error(`focus border: ${(await accent(page)).focus}`);
      if ((await logo()) !== 'rgb(255, 0, 0)') throw new Error(`the provider's logo: ${await logo()}`);
      if (!iconFiles().some((name) => name.startsWith('logo-ff0000-'))) throw new Error(`no red window icon: ${iconFiles().join(', ')}`);
      // The window's webviews take it too.
      await waitFor(
        async () => {
          for (const frame of webviewFrames()) {
            if ((await accent(frame).catch(() => undefined))?.focus === '#ff0000') return true;
          }
          return false;
        },
        5000,
        "the provider's accent in a webview",
      );
      // The open conversation keeps its Claude process until the window reloads, as the notice offers.
      const reload = page.locator('.toast .button', { hasText: 'Reload Window' });
      await reload.waitFor({ timeout: 5000 });
      await reloaded(() => reload.click());

      // The session list shows what the provider cost, in place of the extension's figures:
      // here ¥2 + ¥4 + ¥0.40; elsewhere ¥2 more, and a model with no price.
      const list = await waitFor(
        async () => {
          for (const frame of webviewFrames()) {
            const title = await frame
              .locator('[data-vilaus-usage] .sectionLabel_djirOA')
              .textContent({ timeout: 500 })
              .catch(() => '');
            if (title === 'Usage · Mock API') return frame;
          }
          return undefined;
        },
        30_000,
        'the usage block in the session list',
      );
      const usageRows = () =>
        list
          .locator('[data-vilaus-usage] .accountRow_JuUW3A')
          .evaluateAll((rows) =>
            Object.fromEntries(
              rows.map((row) => [
                row.querySelector('.accountLabel_JuUW3A')?.textContent,
                row.querySelector('.accountValue_JuUW3A')?.textContent,
              ]),
            ),
          );
      await waitFor(async () => (await usageRows())['This workspace'] === '¥6.40', 10_000, 'the workspace’s cost');
      const shown = await usageRows();
      if (shown['Claude Code history'] !== '≥ ¥8.40') throw new Error(`usage: ${JSON.stringify(shown)}`);
      const note = await list.locator('.vilaus-usage-note').textContent();
      if (note !== 'No price for mock-haiku') throw new Error(`unpriced note: ${note}`);
      // Its link opens the provider's prices.
      await list.locator('[data-vilaus-usage] .sectionLink_djirOA').first().click();
      const priceInput = page.locator('#content-pane .providers-price-row[data-model="mock-model"] .providers-price[data-field="input"]');
      await priceInput.waitFor({ timeout: 5000 });
      if ((await priceInput.inputValue()) !== '2') throw new Error(`the mock model's input price: ${await priceInput.inputValue()}`);
      // An AI chat's answer pasted back, with a rule: calls with a long input cost twice as much.
      // An answer with problems is told and cannot be used; a good one is previewed, used, saved.
      const editor = page.locator('#content-pane .providers-editor');
      await editor.locator('.providers-prices-paste').click();
      const answerBox = editor.locator('.providers-pricing-text');
      await answerBox.fill('{"currency": "CNY", "models": {"mock-model": {"input": 2, "output": -8}}}');
      await waitFor(async () => (await editor.locator('.providers-pricing-problem').count()) > 0, 5000, 'the problem of the answer');
      if (await editor.locator('.providers-pricing-apply').isEnabled()) throw new Error('an answer with problems can be used');
      const answer = {
        vilausPricing: 1,
        currency: 'CNY',
        models: {
          'mock-model': {
            input: 2,
            cacheRead: 0.2,
            output: 8,
            rules: [{ label: 'Long', when: { inputOver: 1_500_000 }, input: 4, cacheRead: 0.4, output: 16 }],
          },
        },
        sources: [{ url: 'https://example.com/prices', checked: '2026-10-13' }],
      };
      await answerBox.fill(`Here you go:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``);
      await waitFor(async () => (await editor.locator('.providers-pricing-rule').count()) === 1, 5000, 'the preview of the rule');
      await editor.locator('.providers-pricing-apply').click();
      await editor.locator('.providers-price-row[data-model="mock-model"] .providers-price-rules').waitFor({ timeout: 5000 });
      await editor.locator('.providers-save').click();
      await waitFor(() => readFileSync(path.join(dataDir, 'providers.json'), 'utf8').includes('"Long"'), 5000, 'the rule saved');
      // The workspace's call had 3M input tokens, cache hits included: all at the rule's prices now.
      await waitFor(async () => (await usageRows())['This workspace'] === '¥12.80', 10_000, 'the workspace’s cost by the rule');
      const ruled = await usageRows();
      if (ruled['Claude Code history'] !== '≥ ¥14.80') throw new Error(`usage by the rule: ${JSON.stringify(ruled)}`);
      // The editor tells the API's total too (deleted conversations would stay in it).
      await waitFor(
        async () =>
          (await editor.locator('.providers-prices-total').textContent()) ===
          'All of Claude Code on this API: ≥ ¥14.80, deleted conversations included',
        10_000,
        'the total under the prices',
      );
      await page.locator('#content-pane .content-tab.active .tab-close').click();

      // A new conversation (the first one holds comments that later steps expect).
      const before = await tabCount();
      await press('Control+N');
      await waitFor(async () => (await tabCount()) === before + 1, 20_000, 'a new conversation');
      const frame = await waitFor(conversationFrame, 10_000, 'the new conversation');
      const input = frame.locator('[role="textbox"][aria-label="Message input"]');
      await input.waitFor({ timeout: 30_000 });
      // Every state the logo goes through (the mock answers at once).
      await page.evaluate(() => {
        const element = document.querySelector('.titlebar-logo');
        window.logoStates = [element.dataset.activity];
        new MutationObserver(() => window.logoStates.push(element.dataset.activity)).observe(element, {
          attributeFilter: ['data-activity'],
        });
      });
      await input.click();
      await input.fill('hello mock');
      await frame.locator('button[aria-label="Send message"]').click();
      const request = await waitFor(
        () => mock.requests.find((candidate) => candidate.body?.model === 'mock-model'),
        60_000,
        'a request for the main model at the mock API',
      );
      if (request.headers.authorization !== 'Bearer test-key-123') throw new Error(`authorization: ${request.headers.authorization}`);
      // Told at the end, once the conversation is closed: the later steps expect it closed.
      // As x-api-key too, only its own key: never the Anthropic key of Claude Code's own login.
      const otherKey = request.headers['x-api-key'] !== undefined && request.headers['x-api-key'] !== 'test-key-123';
      // Its session is marked with the mock's color in the list; the toggle by the filters keeps
      // only the window's provider's sessions.
      const mark = list.locator('button[id^="sessions-list-row-"] .vilaus-provider-mark[title="Mock API"]');
      await waitFor(async () => (await mark.count()) > 0, 15_000, 'the session marked with its provider');
      const toggle = list.locator('.vilaus-provider-filter');
      if ((await toggle.getAttribute('aria-pressed')) !== 'false') throw new Error('the provider filter starts on');
      await toggle.click();
      await waitFor(() => readSettings()['vilaus.sessions.currentProviderOnly'] === true, 5000, 'the filter setting');
      await waitFor(async () => (await toggle.getAttribute('aria-pressed')) === 'true', 5000, 'the toggle pressed');
      if ((await mark.count()) === 0) throw new Error("the window's provider's session went with the filter");
      await page.screenshot({ path: path.join(runDir, 'usage.png') });
      await toggle.click();
      await waitFor(() => readSettings()['vilaus.sessions.currentProviderOnly'] === undefined, 5000, 'the filter setting removed');
      // While Claude worked, the logo said so (the extension's state, through the bridge and main).
      await waitFor(() => page.evaluate(() => window.logoStates.includes('running')), 10_000, 'the logo to show Claude at work');
      await press('Control+W');
      await waitFor(async () => (await tabCount()) === before, 10_000, 'the conversation to close');
      await waitFor(
        () => page.evaluate(() => document.querySelector('.titlebar-logo').dataset.activity === 'idle'),
        10_000,
        'the logo to rest once the conversation is closed',
      );
      // After a reply too, the extension's own figures (Claude's prices) stay out of the list.
      if ((await list.locator('.sectionLabel_djirOA', { hasText: 'Account & usage' }).count()) > 0) {
        throw new Error("the extension's own usage shows");
      }
      if (otherKey) throw new Error('another key went out as x-api-key');
      return `${mock.requests.length} requests at the mock; ${request.method} ${request.url}; logo ${await page.evaluate(() => window.logoStates.join(' > '))}; usage ${JSON.stringify(shown)}`;
    } finally {
      mock.server.close();
      // Back to the subscription, with fresh processes, for the rest of the run.
      await page.evaluate(() => window.vilausNative.invoke('providers.select', { id: 'subscription' })).catch(() => {});
      await reloadWindow().catch(() => {});
    }
  },
);

await step('back on the subscription, the session list has no usage block of the shell', async () => {
  const list = await waitFor(
    async () => {
      for (const frame of webviewFrames()) {
        if (
          (await frame
            .locator('.root_djirOA')
            .count()
            .catch(() => 0)) > 0
        )
          return frame;
      }
      return undefined;
    },
    30_000,
    'the session list',
  );
  // Give a stale block the time it would take to be posted.
  await page.waitForTimeout(1500);
  const blocks = await list.locator('[data-vilaus-usage]').count();
  if (blocks > 0) throw new Error(`${blocks} usage block element(s) on the subscription`);
});

await step('a conversation that ran on another API says so when it opens, and switches the window to it', async () => {
  const tags = readFileSync(path.join(dataDir, 'session-providers.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const sessionId = tags.find((tag) => tag.p === 'mock')?.s;
  if (!sessionId) throw new Error(`no session tagged with the mock: ${JSON.stringify(tags)}`);
  const row = `[id="sessions-list-row-${sessionId}"]`;
  const list = await waitFor(
    async () => {
      for (const frame of webviewFrames()) {
        if (
          (await frame
            .locator(row)
            .count()
            .catch(() => 0)) > 0
        )
          return frame;
      }
      return undefined;
    },
    30_000,
    'the mock’s session in the list',
  );
  const before = await tabCount();
  await list.locator(row).click();
  const found = await waitFor(
    async () => {
      for (const frame of webviewFrames()) {
        const notice = frame.locator('.vilaus-provider-notice');
        if ((await notice.count().catch(() => 0)) > 0) return notice;
      }
      return undefined;
    },
    30_000,
    'the provider notice',
  );
  const text = await found.locator('.vilaus-provider-notice-text').textContent();
  if (!text.includes('Mock API') || !text.includes('Claude subscription')) throw new Error(`notice: ${text}`);
  await page.screenshot({ path: path.join(runDir, 'provider-notice.png') });
  await found.locator('.vilaus-provider-notice-switch').click();
  await waitFor(async () => (await page.locator('.titlebar-provider-label').innerText()) === 'Mock API', 20_000, 'the window on the mock');
  // The preview closed, the conversation opens again (its old Claude process ended first), under the mock now.
  await waitFor(async () => (await tabCount()) === before + 1, 30_000, 'the conversation open again');
  await page.waitForTimeout(1500);
  for (const frame of webviewFrames()) {
    if (
      (await frame
        .locator('.vilaus-provider-notice')
        .count()
        .catch(() => 0)) > 0
    )
      throw new Error('a notice under the right provider');
  }
  // As the run had it: the conversation closed, back on the subscription with fresh processes.
  await press('Control+W');
  await waitFor(async () => (await tabCount()) === before, 10_000, 'the reopened conversation to close');
  await page.evaluate(() => window.vilausNative.invoke('providers.select', { id: 'subscription' }));
  await reloadWindow();
  return text;
});

await step("a question's options: dragging over their text selects it, to be copied, without picking the option", async () => {
  // Claude asks (AskUserQuestion) when the prompt says so; the question waits for an answer.
  const question = {
    questions: [
      {
        question: 'Which color should the button be?',
        header: 'Color',
        multiSelect: false,
        options: [
          { label: 'Warm red', description: 'A warm color for the main button' },
          { label: 'Cool blue', description: 'A calm color that matches the theme' },
        ],
      },
    ],
  };
  // (The CLI's request may end in a message of its own: the prompt is looked for anywhere, until answered.)
  const mock = await startMockApi({
    toolUse: (body) => {
      const conversation = JSON.stringify(body?.messages ?? []);
      return conversation.includes('ASK-ME-A-QUESTION') &&
        !conversation.includes('"tool_result"') &&
        body?.tools?.some((tool) => tool.name === 'AskUserQuestion')
        ? { name: 'AskUserQuestion', input: question }
        : undefined;
    },
  });
  const before = await tabCount();
  try {
    await page.evaluate(async (port) => {
      await window.vilausNative.invoke('providers.save', {
        provider: {
          id: 'question-mock',
          name: 'Question Mock',
          type: 'compatible',
          baseUrl: `http://127.0.0.1:${port}`,
          auth: 'bearer',
          models: { main: 'mock-model', haiku: 'mock-haiku' },
        },
      });
      await window.vilausNative.invoke('providers.setKey', { id: 'question-mock', key: 'test-key-456' });
      await window.vilausNative.invoke('providers.select', { id: 'question-mock' });
    }, mock.port);
    await reloadWindow();
    await press('Control+N');
    await waitFor(async () => (await tabCount()) === before + 1, 20_000, 'a new conversation');
    const frame = await waitFor(conversationFrame, 10_000, 'the new conversation');
    const input = frame.locator('[role="textbox"][aria-label="Message input"]');
    await input.waitFor({ timeout: 30_000 });
    await input.click();
    await input.fill('ASK-ME-A-QUESTION');
    await frame.locator('button[aria-label="Send message"]').click();
    const option = (label) => frame.locator('.option_hONcXw', { hasText: label });
    await option('Warm red')
      .waitFor({ timeout: 60_000 })
      .catch(async (error) => {
        const asked = mock.requests.map(
          (request) =>
            `${request.body?.model}: ${request.body?.tools?.length ?? 0} tools${request.body?.tools?.some((tool) => tool.name === 'AskUserQuestion') ? ' (asks)' : ''}, last ${JSON.stringify(request.body?.messages?.at(-1))?.slice(0, 300)}`,
        );
        const shown = (await frame.evaluate(() => document.body.innerText).catch(() => '')).slice(-300);
        throw new Error(`${error.message}; requests ${asked.join(', ')}; the page ends "${shown}"`);
      });
    const picked = () => frame.locator('.option_hONcXw').evaluateAll((options) => options.map((o) => o.getAttribute('aria-checked')));
    const description = option('Warm red').locator('.optionDescription_hONcXw');
    const looks = await description.evaluate((element) => `${getComputedStyle(element).userSelect} ${getComputedStyle(element).cursor}`);
    if (looks !== 'text text') throw new Error(`the description's user-select and cursor: ${looks}`);
    // Dragged over with the mouse: the text is selected, and the option is not picked.
    const box = await description.boundingBox();
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const selected = await frame.evaluate(() => getSelection()?.toString());
    if (selected !== 'A warm color for the main button' || (await picked()).includes('true')) {
      throw new Error(`after the drag: selected "${selected}", picked ${await picked()}`);
    }
    // Ctrl+C copies it (the page's copy is caught here: the clipboard is left alone).
    await frame.evaluate(() =>
      document.addEventListener(
        'copy',
        (event) => {
          window.vilausCopied = getSelection()?.toString();
          event.preventDefault();
        },
        { once: true },
      ),
    );
    await page.keyboard.press('Control+C');
    const copied = await waitFor(() => frame.evaluate(() => window.vilausCopied), 5000, 'the copy');
    if (copied !== selected) throw new Error(`copied "${copied}"`);
    // A click that selects nothing picks the option, the selection still there or not.
    await option('Warm red').click({ position: { x: 8, y: 10 } });
    await waitFor(async () => (await picked())[0] === 'true', 5000, 'the option picked by a click');
    await option('Cool blue').locator('.optionLabel_hONcXw').click();
    await waitFor(async () => (await picked()).join() === 'false,true,false', 5000, 'the other option picked');
    return `copied "${copied}"`;
  } finally {
    if ((await tabCount()) > before) {
      await press('Control+W');
      await waitFor(async () => (await tabCount()) === before, 10_000, 'the conversation to close').catch(() => {});
    }
    mock.server.close();
    await page
      .evaluate(async () => {
        await window.vilausNative.invoke('providers.select', { id: 'subscription' });
        await window.vilausNative.invoke('providers.remove', { id: 'question-mock' });
      })
      .catch(() => {});
    await reloadWindow().catch(() => {});
  }
});

await step('the providers editor adds a provider from a preset, saves edits and a key, and removes it', async () => {
  await press('Control+Shift+P');
  await page.locator('.quick-input-filter').fill('>Manage API Providers');
  await page.locator('.quick-input-filter').press('Enter');
  const editor = page.locator('#content-pane .providers-editor');
  await editor.waitFor({ timeout: 5000 });
  await editor.locator('.providers-add').click();
  await page.locator('.quick-input-filter').fill('DeepSeek');
  await page.locator('.quick-input-filter').press('Enter');
  const selected = editor.locator('.providers-list-item.selected .providers-list-label');
  await waitFor(async () => (await selected.innerText().catch(() => '')) === 'DeepSeek', 5000, 'the new provider selected');
  const baseUrl = await editor.locator('.setting-input[placeholder="ANTHROPIC_BASE_URL"]').inputValue();
  if (baseUrl !== 'https://api.deepseek.com/anthropic') throw new Error(`base URL ${baseUrl}`);
  // It starts with the prices the preset ships (rules by the time of day among them), and
  // offers them again through the paste's preview.
  const flashPrices = editor.locator('.providers-price-row[data-model="deepseek-flash"]');
  if ((await flashPrices.locator('.providers-price[data-field="input"]').inputValue()) === '')
    throw new Error('no default price for deepseek-flash');
  if ((await flashPrices.locator('.providers-price-rules').count()) !== 1)
    throw new Error('the default rules of deepseek-flash are not marked');
  await editor.locator('.providers-prices-defaults').click();
  await waitFor(async () => (await editor.locator('.providers-pricing-rule').count()) > 0, 5000, 'the default prices previewed');
  await editor.locator('.providers-pricing-paste .providers-prices-bar .button.secondary').click();

  const name = editor.locator('.providers-row').first().locator('.setting-input');
  await name.fill('DeepSeek Work');
  await editor.locator('.providers-save').click();
  const saved = () => JSON.parse(readFileSync(path.join(dataDir, 'providers.json'), 'utf8'));
  await waitFor(() => saved().providers.some((provider) => provider.name === 'DeepSeek Work'), 5000, 'the name in providers.json');
  // Its prices: a row per model its fields name (deepseek-flash[1m] is deepseek-flash) or it has
  // prices for (the preset's deepseek-v4-pro), in the currency it bills in.
  const flash = editor.locator('.providers-price-row[data-model="deepseek-flash"]');
  await flash.waitFor({ timeout: 5000 });
  const priceRows = await editor.locator('.providers-price-row[data-model]').evaluateAll((rows) => rows.map((row) => row.dataset.model));
  if (priceRows.join() !== 'deepseek-flash,deepseek-v4-pro') throw new Error(`not one price row per model: ${priceRows.join(', ')}`);
  if ((await editor.locator('.providers-prices .setting-select').inputValue()) !== 'CNY') throw new Error('the prices are not in CNY');
  await flash.locator('[data-field="input"]').fill('2');
  await flash.locator('[data-field="output"]').fill('8');
  await editor.locator('.providers-save').click();
  await waitFor(
    () => saved().providers.some((provider) => provider.pricing?.models?.['deepseek-flash']?.output === 8),
    5000,
    'the prices in providers.json',
  );
  await editor.locator('.providers-key').fill('sk-deepseek-test');
  await editor.locator('.button', { hasText: 'Save Key' }).click();
  await waitFor(async () => (await editor.innerText()).includes('A key is stored'), 5000, 'the stored key');
  if (JSON.stringify(saved()).includes('sk-deepseek-test')) throw new Error('the key is stored in clear');
  await page.screenshot({ path: path.join(runDir, 'providers.png') });

  await editor.locator('.providers-remove').click();
  await page.locator('.modal .button', { hasText: 'Remove Provider' }).click();
  await waitFor(() => !saved().providers.some((provider) => provider.name === 'DeepSeek Work'), 5000, 'the provider to go');
  if (Object.keys(saved().keys).some((id) => id.startsWith('deepseek'))) throw new Error('its key stayed');
  await page.locator('#content-pane .content-tab.active .tab-close').click();
  return 'added, renamed, key stored encrypted, removed';
});

// Only a record of the run: a window that draws no frame (a display asleep) must not end it.
await page.screenshot({ path: path.join(runDir, 'final.png'), timeout: 10_000 }).catch(() => {});

await step('open conversations are restored after a restart', async () => {
  await press('Control+N');
  await waitFor(async () => (await tabCount()) === 2, 20_000, 'a second tab');
  // Let the panel save its state (PanelRestore debounces writes).
  await page.waitForTimeout(1500);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await waitFor(async () => (await tabCount()) === 2, 30_000, 'both tabs to come back');
  // The first conversation's comments (not sent yet) come back with it.
  await waitFor(
    async () => {
      for (const frame of webviewFrames()) {
        if (
          (await commentBlocks(frame)
            .count()
            .catch(() => 0)) === 4
        )
          return true;
      }
      return false;
    },
    30_000,
    'the four comments to come back',
  );
  return `${await tabCount()} tabs restored, with the comments`;
});

await step('when the page has no place for them, comments show in a bar below the conversation', async () => {
  await page.locator('#tabs .tab').first().click();
  const frame = await waitFor(
    async () => {
      const candidate = await conversationFrame();
      return candidate && (await commentBlocks(candidate).count()) === 4 ? candidate : undefined;
    },
    10_000,
    'the conversation with comments',
  );
  await frame.evaluate(() => document.querySelector('form:has([role="textbox"][aria-label="Message input"])')?.remove());
  const bar = page.locator('#main .panel:not([hidden]) .comments-bar:not([hidden])');
  await waitFor(async () => (await bar.locator('.comments-bar-item').count()) === 4, 5000, 'the shell bar with four comments');
  await bar.locator('[data-action="clear"]').click();
  await waitFor(async () => (await bar.count()) === 0, 5000, 'the bar to go once the comments are cleared');
});

await step('Configure Display Language switches the shell to Chinese after a restart', async () => {
  await press('Control+Shift+P');
  const filter = page.locator('.quick-input-filter');
  await filter.waitFor({ timeout: 5000 });
  await filter.fill('>Configure Display Language');
  await filter.press('Enter');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) === 3, 5000, 'the three choices');
  await page.locator('.quick-input-filter').fill('中文');
  await page.locator('.quick-input-filter').press('Enter');
  const restart = page.locator('.toast .button', { hasText: 'Restart' });
  await waitFor(async () => (await restart.count()) > 0, 5000, 'the restart prompt');
  const saved = JSON.parse(readFileSync(settingsFile, 'utf8'))['vilaus.language'];
  if (saved !== 'zh-cn') throw new Error(`vilaus.language is ${saved}`);

  // What the Restart button does (app.relaunch), by hand: Playwright cannot follow a relaunch.
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await waitFor(() => webviewFrames().length >= 2, 30_000, 'the webviews to come back');
  const lang = await page.evaluate(() => document.documentElement.lang);
  if (lang !== 'zh-CN') throw new Error(`html lang is ${lang}`);

  await press('Control+Shift+P');
  await page.locator('.quick-input-filter').waitFor({ timeout: 5000 });
  await page.locator('.quick-input-filter').fill('>新建对话');
  const command = await waitFor(
    async () => {
      const rows = page.locator('.quick-input-item');
      return (await rows.count()) ? rows.first().innerText() : undefined;
    },
    5000,
    'the Chinese command',
  );
  await page.locator('.quick-input-filter').press('Escape');

  const menu = await withRecordedMenus(async () => {
    return openContextMenu(activeConversation());
  });
  const expected = ['将会话标签页添加到分组', '将会话标记为未读', '重命名会话标签页'];
  if (!expected.every((label) => menu.includes(label))) throw new Error(`menu was: ${menu.join(' | ')}`);
  return `palette: ${command.replace(/\s+/g, ' ')}; menu: ${menu.join(' | ')}`;
});

await step(
  "in Chinese the extension's UI is Chinese too; its content and aria-labels are not, and the setting applies at once",
  async () => {
    const cjk = /[一-鿿]/;
    const frame = await waitFor(conversationFrame, 10_000, 'the conversation');
    // Found by its aria-label, which stays English.
    const input = frame.locator('[role="textbox"][aria-label="Message input"]');
    await input.waitFor({ timeout: 30_000 });
    const placeholder = await waitFor(
      async () => {
        const value = await input.getAttribute('data-placeholder');
        return value && cjk.test(value) ? value : undefined;
      },
      10_000,
      'a Chinese input placeholder',
    );
    const sessions = webviewFrames().find((candidate) => candidate !== frame);
    const listText = sessions ? await sessions.locator('body').innerText() : '';
    if (!cjk.test(listText)) throw new Error(`the session list says ${JSON.stringify(listText.slice(0, 200))}`);

    // Text in a part of the page that shows content keeps its words, even ones the table has.
    const texts = await frame.evaluate(async () => {
      const region = document.createElement('div');
      region.setAttribute('aria-label', 'Claude Code conversation');
      region.innerHTML = '<p>New session</p>';
      const outside = document.createElement('p');
      outside.textContent = 'New session';
      document.body.append(region, outside);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = [region.innerText.trim(), outside.textContent ?? ''];
      region.remove();
      outside.remove();
      return result;
    });
    if (texts[0] !== 'New session' || !cjk.test(texts[1])) throw new Error(`content / UI text: ${texts.join(' / ')}`);

    // Turned off, the page shows its own text again at once; turned on, Chinese again.
    const settings = readSettings();
    writeFileSync(settingsFile, JSON.stringify({ ...settings, 'vilaus.translateExtensionUi': false }, null, 2), 'utf8');
    await waitFor(async () => !cjk.test((await input.getAttribute('data-placeholder')) ?? '中'), 10_000, 'the English placeholder');
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    await waitFor(async () => cjk.test((await input.getAttribute('data-placeholder')) ?? ''), 10_000, 'the Chinese placeholder again');

    // What the extension shows in the shell (Rename Session Tab's input box, or its notice) is Chinese.
    const outcome = await withRecordedMenus(async () => {
      await openContextMenu(activeConversation());
      await clickRecordedMenuItem('重命名会话标签页');
      return waitFor(
        async () => {
          if (await page.locator('.quick-input-filter').count()) return 'input box';
          const toast = page.locator('.toast-message');
          return (await toast.count()) ? `message "${await toast.first().innerText()}"` : undefined;
        },
        10_000,
        'the rename command to answer',
      );
    });
    let rename = outcome;
    if (outcome === 'input box') {
      await page.locator('.quick-input-filter').fill('');
      await page.locator('.quick-input-filter').press('Enter');
      rename = await waitFor(
        async () => {
          const validation = page.locator('.quick-input-validation');
          return (await validation.count()) ? validation.innerText() : undefined;
        },
        5000,
        'the validation message',
      );
      await page.locator('.quick-input-filter').press('Escape');
    } else {
      await page.locator('.toast-close').first().click();
    }
    if (!cjk.test(rename)) throw new Error(`the rename answered in English: ${rename}`);
    return `placeholder "${placeholder}"; rename: ${rename}`;
  },
);

await step('started without a folder, the windows open at quit come back', async () => {
  const opened = app.waitForEvent('window');
  await openFolder(page, second, true);
  const newPage = await opened;
  await waitFor(async () => showsFolder(await newPage.title(), second), 30_000, 'the second window');
  await app.close();
  app = await electron.launch({
    executablePath: executable,
    args: appArgs('--user-data-dir', dataDir, '--secondary-display'),
    cwd: root,
    env,
    timeout: 60_000,
  });
  page = await app.firstWindow();
  const titles = await waitFor(
    async () => {
      const shown = await Promise.all(shellPages().map((candidate) => candidate.title()));
      const both = [second, workspace].every((folder) => shown.some((title) => showsFolder(title, folder)));
      return shown.length === 2 && both ? shown : undefined;
    },
    30_000,
    'the two windows',
  );
  return titles.join(', ');
});

/** A .vsix like Open VSX's (`extension/` and `extension.vsixmanifest` in a zip); resolves to its path. */
function makeVsix(version, publisher = 'Anthropic') {
  const dir = path.join(runDir, `vsix-${publisher}-${version}`);
  mkdirSync(path.join(dir, 'extension'), { recursive: true });
  writeFileSync(
    path.join(dir, 'extension', 'package.json'),
    JSON.stringify({ publisher, name: 'claude-code', version, main: './extension.js' }),
  );
  writeFileSync(path.join(dir, 'extension', 'extension.js'), 'exports.activate = () => {};\n');
  writeFileSync(
    path.join(dir, 'extension.vsixmanifest'),
    `<PackageManifest><Metadata><Identity Id="claude-code" Version="${version}" Publisher="${publisher}" TargetPlatform="win32-x64"/></Metadata></PackageManifest>`,
  );
  // bsdtar (Windows' tar.exe) picks the format from the suffix.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', 'package.zip', 'extension', 'extension.vsixmanifest'], { cwd: dir });
  return path.join(dir, 'package.zip');
}

const readExtensionState = () => JSON.parse(readFileSync(path.join(dataDir, 'extensions', 'state.json'), 'utf8'));

/** A JSON file's contents; undefined while it is missing or half-written. */
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/** The workspace window with the settings editor on Extension Version; resolves to the page and the block. */
async function openExtensionVersion() {
  const main = await waitFor(
    async () => {
      for (const candidate of shellPages()) {
        if (showsFolder(await candidate.title(), workspace)) return candidate;
      }
      return undefined;
    },
    30_000,
    'the workspace window',
  );
  await press('Control+,');
  await main.locator('.settings-dialog .settings-editor').waitFor({ timeout: 10_000 });
  await main.locator('.settings-dialog .settings-search').fill('extension version');
  const widget = main.locator('.settings-dialog .settings-widget[data-widget="extensionUpdates.version"]');
  await widget.waitFor({ timeout: 5000 });
  return { main, widget };
}

await step('first run: no extension, no Git -> install from Open VSX without a restart, then connect with an API provider', async () => {
  // An instance of its own: a fresh data folder, no VSCodium copy, no Git anywhere it looks.
  const firstRoot = path.join(runDir, 'first-run');
  const firstData = path.join(firstRoot, 'data');
  const firstWorkspace = path.join(firstRoot, 'workspace');
  for (const dir of [firstData, firstWorkspace]) mkdirSync(dir, { recursive: true });
  const vsix = readFileSync(makeVsix('9.0.0'));
  const sha256 = createHash('sha256').update(vsix).digest('hex');
  let base = '';
  const openVsx = createServer((request, response) => {
    if (request.url === '/api/anthropic/claude-code/win32-x64') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          namespace: 'Anthropic',
          name: 'claude-code',
          version: '9.0.0',
          targetPlatform: 'win32-x64',
          files: { download: `${base}/package.vsix`, sha256: `${base}/package.sha256` },
        }),
      );
    } else if (request.url === '/package.vsix') {
      response.writeHead(200, { 'content-length': vsix.length }).end(vsix);
    } else if (request.url === '/package.sha256') {
      response.end(sha256);
    } else {
      response.writeHead(404).end();
    }
  });
  base = `http://127.0.0.1:${await listenOnSafePort(openVsx)}`;
  writeFileSync(
    path.join(firstData, 'settings.json'),
    JSON.stringify({ 'vilaus.language': 'en', 'vilaus.extension.autoUpdate': false, 'vilaus.extension.openVsxUrl': base }),
    'utf8',
  );
  // Claude Code looks for Git on PATH (and CLAUDE_CODE_GIT_BASH_PATH), so does the shell.
  // Variable names ignore case on Windows: match them whatever their case.
  const noGit = {};
  for (const [name, value] of Object.entries(env)) {
    if (/^claude_code_git_bash_path$/i.test(name)) continue;
    noGit[name] = /^path$/i.test(name)
      ? value
          .split(';')
          .filter((dir) => !/git/i.test(dir))
          .join(';')
      : value;
  }

  const first = await electron.launch({
    executablePath: executable,
    args: appArgs('--user-data-dir', firstData, '--folder', firstWorkspace, '--secondary-display', '--ignore-other-editors'),
    cwd: root,
    env: noGit,
    timeout: 60_000,
  });
  try {
    const firstPage = await first.firstWindow();
    const setup = firstPage.locator('.setup-page');
    await setup.waitFor({ timeout: 30_000 });
    await firstPage.locator('.toast', { hasText: 'Git for Windows was not found' }).waitFor({ timeout: 10_000 });
    // Connecting waits for the extension.
    if (!(await firstPage.locator('.setup-provider').isDisabled())) throw new Error('step 2 is enabled before the install');

    await firstPage.locator('.setup-download').click();
    const status = firstPage.locator('.setup-status');
    await waitFor(
      async () => (await status.innerText()) === 'Claude Code 9.0.0 is installed.',
      60_000,
      'the install and the extension host',
    );
    await waitFor(
      () => readJson(path.join(firstData, 'extensions', 'state.json'))?.lastGood === '9.0.0',
      30_000,
      'the new extension to activate',
    );
    await firstPage.screenshot({ path: path.join(runDir, 'first-run.png') });

    await firstPage.locator('.setup-provider').click();
    await firstPage.locator('.quick-input-filter').fill('DeepSeek');
    await firstPage.locator('.quick-input-filter').press('Enter');
    await setup.waitFor({ state: 'detached', timeout: 10_000 });
    const providers = await waitFor(() => readJson(path.join(firstData, 'providers.json'))?.providers, 10_000, 'the new provider');
    const { id } = providers[0];
    // The key, as the editor saves it; the window then switches to the provider.
    await firstPage.evaluate((params) => window.vilausNative.invoke('providers.setKey', params), { id, key: 'sk-first-run' });
    await waitFor(
      async () => (await firstPage.locator('.titlebar-provider-label').innerText()) === 'DeepSeek',
      10_000,
      'the window to use DeepSeek',
    );
    return `installed 9.0.0 from ${base}; provider ${id}`;
  } finally {
    await first.close();
    openVsx.close();
    rmSync(path.join(firstData, 'extensions'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

await step(
  'the session list: the filters are one drop-down, usage resets show the time, and a row deletes its session after asking, open or not',
  async () => {
    // An instance of its own, whose Claude Code folder holds one session of its workspace.
    const own = path.join(runDir, 'delete-session');
    const ownData = path.join(own, 'data');
    const ownWorkspace = path.join(own, 'workspace');
    const claudeDir = path.join(own, 'claude');
    const id = '0f9c2b1e-4d5a-4c3b-9e8f-7a6b5c4d3e2f';
    // Claude Code files a folder's sessions under its path with every other character a dash.
    const project = path.join(claudeDir, 'projects', ownWorkspace.replace(/[^a-zA-Z0-9]/g, '-'));
    const transcript = path.join(project, `${id}.jsonl`);
    mkdirSync(ownData, { recursive: true });
    mkdirSync(ownWorkspace, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(claudeDir, 'file-history', id), { recursive: true });
    const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
    writeFileSync(
      transcript,
      [
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          sessionId: id,
          timestamp: at(60),
          cwd: ownWorkspace,
          message: { role: 'user', content: 'Tidy the downloads folder' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: id,
          timestamp: at(50),
          cwd: ownWorkspace,
          // A reply of a compatible API (the one provider that names its model): ¥2 at its prices.
          message: {
            id: 'msg-tidy',
            role: 'assistant',
            model: 'tidy-model',
            content: [{ type: 'text', text: 'Done.' }],
            usage: { input_tokens: 1_000_000, output_tokens: 0 },
          },
        },
        { type: 'ai-title', aiTitle: 'Tidy the downloads', sessionId: id },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(ownData, 'settings.json'),
      JSON.stringify({
        'claudeCode.hideOnboarding': true,
        'claudeCode.disableLoginPrompt': true,
        'vilaus.language': 'en',
        'vilaus.extension.autoUpdate': false,
      }),
      'utf8',
    );
    const other = await electron.launch({
      executablePath: executable,
      args: appArgs('--user-data-dir', ownData, '--folder', ownWorkspace, '--secondary-display'),
      cwd: root,
      env: { ...env, CLAUDE_CONFIG_DIR: claudeDir, VILAUS_SESSIONS_DIR: path.join(claudeDir, 'projects') },
      timeout: 60_000,
    });
    try {
      const otherPage = await other.firstWindow();
      await otherPage.evaluate(() =>
        window.vilausNative.invoke('providers.save', {
          provider: {
            id: 'tidy',
            name: 'Tidy API',
            type: 'compatible',
            baseUrl: 'http://127.0.0.1:9',
            auth: 'bearer',
            models: { main: 'tidy-model' },
            pricing: { currency: 'CNY', models: { 'tidy-model': { input: 2, output: 8 } } },
          },
        }),
      );
      const rowSelector = `[id="sessions-list-row-${id}"]`;
      const list = await waitFor(
        async () => {
          for (const frame of otherPage.frames()) {
            if (
              frame.url().startsWith('ccw://wv') &&
              (await frame
                .locator(rowSelector)
                .count()
                .catch(() => 0)) === 1
            )
              return frame;
          }
        },
        30_000,
        'the session in the list',
      );
      // One drop-down: the status filter's button carries the Active count; the toggle is hidden.
      const filter = list.locator('.statusFilterMenuButton_OOQiHg[data-vilaus-label="Active · 0"]');
      await filter.waitFor({ timeout: 5000 });
      if (await list.locator('.activeFilterToggle_OOQiHg').isVisible()) throw new Error('the Active toggle shows');
      // A usage bar as the extension draws one (no account is signed in here), and its reset time
      // as the bridge would pass it on: the bar shows the time instead of "in 3h".
      const resetsAt = Date.now() + 3 * 3600_000 + 25 * 60_000;
      await list.evaluate(() => {
        const bar = document.createElement('div');
        bar.className = 'usageBarContainer_8s5nuw';
        bar.innerHTML =
          '<div class="usageBarHeader_8s5nuw"><span class="usageLabel_8s5nuw">Session (5hr)</span></div><span class="resetText_8s5nuw">Resets in 3h</span>';
        document.body.appendChild(bar);
      });
      await otherPage.evaluate((at) => {
        for (const frame of document.querySelectorAll('iframe'))
          frame.contentWindow?.postMessage({ ccwControl: 'usageResets', resets: { 'Session (5hr)': at } }, '*');
      }, resetsAt);
      const time = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(resetsAt);
      await waitFor(
        async () =>
          (await list.locator('.resetText_8s5nuw').evaluate((element) => getComputedStyle(element, '::after').content)).includes(time),
        5000,
        `the reset time ${time}`,
      );
      // The made-up bar sits beside the list and narrows it: gone again.
      await list.evaluate(() => document.querySelector('body > .usageBarContainer_8s5nuw')?.remove());

      // Open in a tab: it is deleted all the same, the tab closed first. Clicked on its name: the
      // row's other end has its buttons.
      const row = list.locator(rowSelector);
      const tabs = () => otherPage.locator('#tabs .tab').count();
      const tabsBefore = await tabs();
      await row.click({ position: { x: 30, y: 10 } });
      await waitFor(async () => (await tabs()) === tabsBefore + 1, 15_000, 'the session in a tab');
      // Its Claude process runs (and says so in sessions/<pid>.json) until the tab closes.
      const runningRecord = () => {
        const records = path.join(claudeDir, 'sessions');
        if (!existsSync(records)) return undefined;
        return readdirSync(records).find((name) => name.endsWith('.json') && readFileSync(path.join(records, name), 'utf8').includes(id));
      };
      await waitFor(() => runningRecord() !== undefined, 15_000, 'its Claude process');
      await row.hover();
      await row.locator('.vilaus-delete-session[title="Delete session"]').click();
      const modal = otherPage.locator('.overlay-box.modal');
      await modal.waitFor({ timeout: 5000 });
      if (!(await modal.innerText()).includes('"Tidy the downloads"')) throw new Error(`the question: ${await modal.innerText()}`);
      // It ran on a compatible API: what it cost leaves the session list's usage, and the question says so.
      if (!(await modal.innerText()).includes('What it cost on Tidy API (¥2.00) also goes from the usage in the session list.'))
        throw new Error(`no word of what it cost: ${await modal.innerText()}`);
      // Cancel keeps it and its tab; Delete deletes it.
      await modal.locator('.button', { hasText: 'Cancel' }).click();
      await otherPage.waitForTimeout(500);
      if (!existsSync(transcript)) throw new Error('deleted on Cancel');
      if ((await tabs()) !== tabsBefore + 1) throw new Error('the tab closed on Cancel');
      await row.hover();
      await row.locator('.vilaus-delete-session').click();
      await modal.locator('.button', { hasText: 'Delete' }).click();
      await waitFor(async () => (await tabs()) === tabsBefore, 5000, 'its tab to close');
      await waitFor(() => !existsSync(transcript) && !existsSync(path.join(claudeDir, 'file-history', id)), 15_000, 'the files to go');
      if (runningRecord() !== undefined) throw new Error('deleted while its Claude process still ran');
      await waitFor(async () => (await list.locator(rowSelector).count()) === 0, 10_000, 'the row to leave the list');
      if (await modal.isVisible()) throw new Error(`a message after deleting: ${await modal.innerText()}`);
      // The process ended before: nothing writes the transcript again.
      await otherPage.waitForTimeout(1000);
      if (existsSync(transcript)) throw new Error('the transcript came back');
      // The API's total keeps what it cost.
      const total = await otherPage.evaluate(() => window.vilausNative.invoke('usage.total', { providerId: 'tidy' }));
      if (total?.value !== '¥2.00') throw new Error(`the total after deleting: ${JSON.stringify(total)}`);
    } finally {
      await other.close();
    }
    return 'its tab closed, transcript and file history deleted, the list read again; the API total kept its cost';
  },
);

await step(
  "the session list: a row's buttons stay out of its title until the row is hovered, and a narrow filter row turns the search box into just its icon with no button cut off",
  async () => {
    // An instance of its own, whose Claude Code folder holds one session of its workspace, with
    // a title long enough to see how much room it gets.
    const own = path.join(runDir, 'list-row');
    const ownData = path.join(own, 'data');
    const ownWorkspace = path.join(own, 'workspace');
    const claudeDir = path.join(own, 'claude');
    const project = path.join(claudeDir, 'projects', ownWorkspace.replace(/[^a-zA-Z0-9]/g, '-'));
    const id = '1b2c3d4e-5f60-4711-8a2b-3c4d5e6f7a8b';
    const title = 'Sort the receipts in Downloads by month and file every statement';
    mkdirSync(ownData, { recursive: true });
    mkdirSync(ownWorkspace, { recursive: true });
    mkdirSync(project, { recursive: true });
    const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
    writeFileSync(
      path.join(project, `${id}.jsonl`),
      [
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          sessionId: id,
          timestamp: at(60),
          cwd: ownWorkspace,
          message: { role: 'user', content: 'Sort the receipts' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: id,
          timestamp: at(50),
          cwd: ownWorkspace,
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        },
        { type: 'ai-title', aiTitle: title, sessionId: id },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(ownData, 'settings.json'),
      JSON.stringify({
        'claudeCode.hideOnboarding': true,
        'claudeCode.disableLoginPrompt': true,
        'vilaus.language': 'en',
        'vilaus.extension.autoUpdate': false,
      }),
      'utf8',
    );
    const other = await electron.launch({
      executablePath: executable,
      args: appArgs('--user-data-dir', ownData, '--folder', ownWorkspace, '--secondary-display'),
      cwd: root,
      env: { ...env, CLAUDE_CONFIG_DIR: claudeDir, VILAUS_SESSIONS_DIR: path.join(claudeDir, 'projects') },
      timeout: 60_000,
    });
    try {
      const otherPage = await other.firstWindow();
      const rowSelector = `[id="sessions-list-row-${id}"]`;
      const list = await waitFor(
        async () => {
          for (const frame of otherPage.frames()) {
            if (
              frame.url().startsWith('ccw://wv') &&
              (await frame
                .locator(rowSelector)
                .count()
                .catch(() => 0)) === 1
            )
              return frame;
          }
        },
        30_000,
        'the session in the list',
      );
      const row = list.locator(rowSelector);
      await row.waitFor({ timeout: 5000 });
      const parts = () =>
        row.evaluate((row) => {
          const box = (selector) => {
            const element = row.querySelector(selector);
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width, display: getComputedStyle(element).display };
          };
          return { name: box('.sessionName_OOQiHg'), time: box('.sessionTime_OOQiHg'), actions: box('.sessionActions_OOQiHg') };
        });

      // Not hovered: the actions are out of the layout, so the title reaches the time.
      await otherPage.mouse.move(2, 2);
      await otherPage.waitForTimeout(200);
      const away = await parts();
      if (away.actions.display !== 'none' || away.actions.width > 0)
        throw new Error(`away from the row its actions take ${away.actions.width}px (${away.actions.display})`);
      if (away.time.left < away.name.right) throw new Error('the title runs under the time');
      if (away.time.left - away.name.right > 12)
        throw new Error(`after the title ${Math.round(away.time.left - away.name.right)}px of room before the time`);
      // Hovered: the three buttons (rename, archive, delete) show and the title makes room.
      await row.hover();
      await otherPage.waitForTimeout(200);
      const hovered = await parts();
      if (hovered.actions.display !== 'flex' || hovered.actions.width < 60) throw new Error('the actions did not appear on hover');
      if (hovered.name.width > away.name.width - 40)
        throw new Error(`the title kept its width on hover (${Math.round(hovered.name.width)} of ${Math.round(away.name.width)})`);
      const buttons = row.locator('.actionButton_OOQiHg');
      if ((await buttons.count()) !== 3) throw new Error(`${await buttons.count()} action buttons`);
      for (let i = 0; i < 3; i++) {
        if (!(await buttons.nth(i).isVisible())) throw new Error(`action button ${i + 1} is hidden on hover`);
      }

      // At the usual width the search box is a box, with the page's own label in it, also
      // with sessions waiting for the user (the count then takes the status label's place).
      await otherPage.mouse.move(2, 2);
      await otherPage.waitForTimeout(150);
      const searchBox = () =>
        list.evaluate(() => {
          const toggle = document.querySelector('.searchToggleButton_OOQiHg');
          return { width: toggle.getBoundingClientRect().width, text: getComputedStyle(toggle, '::after').display };
        });
      const wide = await searchBox();
      await list.evaluate(() => {
        document.querySelector('.statusFilterMenuButton_OOQiHg').setAttribute('data-vilaus-needs-input', 'Needs input · 2');
      });
      await otherPage.waitForTimeout(150);
      const wideWaiting = await searchBox();
      for (const [state, box] of [
        ['', wide],
        [' with sessions waiting', wideWaiting],
      ]) {
        if (box.width < 60 || box.text !== 'block')
          throw new Error(`the search box is not a box at the usual width${state} (${Math.round(box.width)}px, text ${box.text})`);
      }

      // A narrow sidebar with sessions waiting for the user: every control stays inside the
      // row (and the sidebar), and the search box is just its icon, still opening the search.
      const sash = await otherPage.locator('#sidebar-sash').boundingBox();
      await otherPage.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
      await otherPage.mouse.down();
      await otherPage.mouse.move(sash.x + sash.width / 2 - 160, sash.y + sash.height / 2, { steps: 4 });
      await otherPage.mouse.up();
      await otherPage.waitForTimeout(300);
      const sidebar = await otherPage.locator('#sidebar').boundingBox();
      if (sidebar.width > 190) throw new Error(`the sidebar did not narrow (${Math.round(sidebar.width)}px)`);
      // The page may have drawn its filter button again (a new element) meanwhile.
      await list.evaluate(() => {
        document.querySelector('.statusFilterMenuButton_OOQiHg').setAttribute('data-vilaus-needs-input', 'Needs input · 2');
      });
      const filters = await list.evaluate(() => {
        const searchRow = document.querySelector('.searchRow_OOQiHg');
        const rowRect = searchRow.getBoundingClientRect();
        const control = (label, element) => {
          const rect = element.getBoundingClientRect();
          return { label, left: rect.left, right: rect.right, width: rect.width, display: getComputedStyle(element).display };
        };
        const toggle = searchRow.querySelector('.searchToggleButton_OOQiHg');
        return {
          row: { left: rowRect.left, right: rowRect.right, width: rowRect.width },
          viewport: innerWidth,
          controls: [
            control('the status filter', searchRow.querySelector('.statusFilterMenuButton_OOQiHg')),
            control('the provider toggle', searchRow.querySelector('.vilaus-provider-filter')),
            control('the search box', toggle),
            control('New group', [...searchRow.querySelectorAll('.newGroupButton_OOQiHg')].at(-1)),
          ],
          searchText: getComputedStyle(toggle, '::after').display,
          needsInput: getComputedStyle(searchRow.querySelector('.statusFilterMenuButton_OOQiHg'), '::after').content,
        };
      });
      if (!filters.needsInput.includes('Needs input')) throw new Error(`no count of sessions waiting: ${filters.needsInput}`);
      if (filters.row.right > filters.viewport) throw new Error('the filter row runs past the sidebar');
      for (const control of filters.controls) {
        if (control.display === 'none' || control.width < 16) throw new Error(`${control.label} is not shown`);
        if (control.left < filters.row.left - 0.5 || control.right > filters.row.right + 0.5)
          throw new Error(
            `${control.label} is cut off: ${Math.round(control.left - filters.row.left)}..${Math.round(control.right - filters.row.left)} of ${Math.round(filters.row.width)}px`,
          );
      }
      if (filters.controls[2].width > 26 || filters.searchText !== 'none')
        throw new Error(
          `the search box did not shrink to its icon (${Math.round(filters.controls[2].width)}px, text ${filters.searchText})`,
        );
      await list.locator('.searchToggleButton_OOQiHg').click();
      await list.locator('.searchInput_OOQiHg').waitFor({ timeout: 5000 });
      return `the title ${Math.round(away.name.width)}px away from the row and ${Math.round(hovered.name.width)}px hovered; the search box ${Math.round(wide.width)}px (${Math.round(wideWaiting.width)}px with sessions waiting) at the usual width; at ${Math.round(sidebar.width)}px the filter row fits its ${Math.round(filters.row.width)}px`;
    } finally {
      await other.close();
    }
  },
);

await step(
  'a session clicked in the list opens as a preview, its row left in place: another click replaces it, leaving or Escape closes it, a double click keeps it; back and forward (keys, mouse) go between the tabs used; Shift+Escape rewinds',
  async () => {
    // An instance of its own, whose Claude Code folder holds three sessions of its workspace.
    const own = path.join(runDir, 'preview');
    const ownData = path.join(own, 'data');
    const ownWorkspace = path.join(own, 'workspace');
    const claudeDir = path.join(own, 'claude');
    const project = path.join(claudeDir, 'projects', ownWorkspace.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(ownData, { recursive: true });
    mkdirSync(ownWorkspace, { recursive: true });
    mkdirSync(project, { recursive: true });
    const sessions = {
      Alpha: 'a1a1a1a1-0000-4000-8000-000000000001',
      Bravo: 'b2b2b2b2-0000-4000-8000-000000000002',
      Charlie: 'c3c3c3c3-0000-4000-8000-000000000003',
    };
    const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
    for (const [name, id] of Object.entries(sessions)) {
      writeFileSync(
        path.join(project, `${id}.jsonl`),
        [
          {
            type: 'user',
            uuid: `${name}-u`,
            parentUuid: null,
            sessionId: id,
            timestamp: at(60),
            cwd: ownWorkspace,
            message: { role: 'user', content: `${name} question` },
          },
          {
            type: 'assistant',
            uuid: `${name}-a`,
            parentUuid: `${name}-u`,
            sessionId: id,
            timestamp: at(50),
            cwd: ownWorkspace,
            message: { role: 'assistant', content: [{ type: 'text', text: `${name} answer` }] },
          },
          { type: 'ai-title', aiTitle: `${name} session`, sessionId: id },
        ]
          .map((line) => JSON.stringify(line))
          .join('\n'),
        'utf8',
      );
    }
    writeFileSync(
      path.join(ownData, 'settings.json'),
      JSON.stringify({
        'claudeCode.hideOnboarding': true,
        'claudeCode.disableLoginPrompt': true,
        'vilaus.language': 'en',
        'vilaus.extension.autoUpdate': false,
      }),
      'utf8',
    );
    const other = await electron.launch({
      executablePath: executable,
      args: appArgs('--user-data-dir', ownData, '--folder', ownWorkspace, '--secondary-display'),
      cwd: root,
      env: { ...env, CLAUDE_CONFIG_DIR: claudeDir, VILAUS_SESSIONS_DIR: path.join(claudeDir, 'projects') },
      timeout: 60_000,
    });
    try {
      const otherPage = await other.firstWindow();
      const row = (name) => `[id="sessions-list-row-${sessions[name]}"]`;
      // On the name: the row's other end has its buttons.
      const onName = { position: { x: 30, y: 10 } };
      const list = await waitFor(
        async () => {
          for (const frame of otherPage.frames()) {
            if (
              frame.url().startsWith('ccw://wv') &&
              (await frame
                .locator(row('Charlie'))
                .count()
                .catch(() => 0)) === 1
            )
              return frame;
          }
        },
        30_000,
        'the sessions in the list',
      );
      const tabs = otherPage.locator('#tabs .tab');
      const active = otherPage.locator('#tabs .tab.active');
      const tab = (name) => otherPage.locator('#tabs .tab', { hasText: `${name} session` });
      await waitFor(async () => (await tabs.count()) === 1, 30_000, 'the first conversation');
      const first = await active.getAttribute('data-panel-id');
      const showing = async (name, preview) => {
        await waitFor(
          async () =>
            (await active.innerText()).includes(`${name} session`) &&
            (await active.evaluate((element) => element.classList.contains('preview'))) === preview,
          15_000,
          `${name} active${preview ? ', in preview' : ''}`,
        );
      };
      const backTo = async (panelId, how) => {
        await how();
        await waitFor(async () => (await active.getAttribute('data-panel-id')) === panelId, 5000, 'the tab used before');
      };
      const keys = (shortcut) =>
        other.evaluate(({ BrowserWindow }, keyCode) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['alt'] });
          contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['alt'] });
        }, shortcut);
      // Windows sends the mouse's side buttons to the window as app commands where no page takes
      // the mouse; over a page, the page has them (button 3 and 4).
      const mouseBack = () =>
        other.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('app-command', {}, 'browser-backward'));
      const cdp = await otherPage.context().newCDPSession(otherPage);
      const mouseButton = async (button, locator) => {
        const box = await locator.boundingBox();
        const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button,
          buttons: button === 'back' ? 8 : 16,
          clickCount: 1,
        });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
      };
      const conversationFrame = otherPage.locator('#main .panel:not([hidden]) .webview-frame');
      // The rows in the list's order, with the dot of a session open in a tab.
      const rows = () =>
        list
          .locator('button[id^="sessions-list-row-"]')
          .evaluateAll((elements) =>
            elements.map(
              (element) =>
                `${element.querySelector('[class*=sessionName]')?.textContent}${element.querySelector('[title="Open in a tab"]') ? ' (open)' : ''}`,
            ),
          );
      const rowsBefore = await rows();

      await list.locator(row('Alpha')).click(onName);
      await showing('Alpha', true);
      // In preview its row stays where it was clicked, without the dot of an open session.
      await otherPage.waitForTimeout(1000);
      if (JSON.stringify(await rows()) !== JSON.stringify(rowsBefore)) throw new Error(`the rows moved for a preview: ${await rows()}`);
      await list.locator(row('Bravo')).click(onName);
      await showing('Bravo', true);
      await waitFor(async () => (await tabs.count()) === 2 && (await tab('Alpha').count()) === 0, 10_000, 'Bravo in place of Alpha');
      // Back to the first conversation: the preview it leaves closes.
      await backTo(first, () => keys('Left'));
      await waitFor(async () => (await tabs.count()) === 1, 10_000, 'the preview to close');

      // Its tab double-clicked: kept, it stays when the first comes back (the mouse's back button).
      await list.locator(row('Alpha')).click(onName);
      await showing('Alpha', true);
      await active.dblclick();
      await showing('Alpha', false);
      // Kept, it is open: first in the list, with the dot.
      await waitFor(async () => (await rows())[0] === 'Alpha session (open)', 10_000, `Alpha first and open in the list: ${await rows()}`);
      await backTo(first, mouseBack);
      await otherPage.waitForTimeout(500);
      if ((await tabs.count()) !== 2) throw new Error(`a kept tab closed: ${(await tabs.allInnerTexts()).join(' | ')}`);
      await keys('Right');
      await showing('Alpha', false);
      // The mouse's buttons over the conversation's page, and over the shell's.
      await backTo(first, () => mouseButton('back', conversationFrame));
      await mouseButton('forward', tabs.first());
      await showing('Alpha', false);

      // Its row double-clicked: kept from the start.
      await list.locator(row('Bravo')).dblclick(onName);
      await showing('Bravo', false);
      await waitFor(async () => (await tabs.count()) === 3, 10_000, 'Bravo kept next to Alpha');

      // The page's own uses of Escape are the shell's keybindings: Shift+Escape opens its rewind
      // picker; two plain Escapes in the empty input no longer do (and interrupt nothing).
      const frameOf = async () => (await conversationFrame.elementHandle())?.contentFrame();
      const bravoPage = await waitFor(
        async () => {
          const frame = await frameOf();
          return (await frame?.locator('[role="textbox"][aria-label="Message input"]').count()) === 1 ? frame : undefined;
        },
        30_000,
        "Bravo's input",
      );
      const input = bravoPage.locator('[role="textbox"][aria-label="Message input"]');
      const rewindPicker = bravoPage.locator('[role="dialog"]', { hasText: 'Rewind to' });
      await input.click();
      await input.press('Escape');
      await input.press('Escape');
      await otherPage.waitForTimeout(800);
      if ((await rewindPicker.count()) > 0) throw new Error('two Escapes opened the rewind picker');
      await other.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape', modifiers: ['shift'] });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape', modifiers: ['shift'] });
      });
      await rewindPicker.waitFor({ timeout: 5000 });
      // Escape closes the picker, and only that.
      await bravoPage.locator('[role="dialog"]').press('Escape');
      await waitFor(async () => (await rewindPicker.count()) === 0, 5000, 'the picker to close');
      await otherPage.waitForTimeout(300);
      if ((await tabs.count()) !== 3) throw new Error('the Escape that closed the picker closed the tab');

      // Escape in a preview closes it (the input is empty: the page has no use for one Escape).
      const bravo = await active.getAttribute('data-panel-id');
      await list.locator(row('Charlie')).click(onName);
      await showing('Charlie', true);
      const charlie = await waitFor(
        async () => {
          const handle = await otherPage.locator('#main .panel:not([hidden]) .webview-frame').elementHandle();
          const frame = await handle?.contentFrame();
          return (await frame?.locator('[role="textbox"][aria-label="Message input"]').count()) === 1 ? frame : undefined;
        },
        30_000,
        "Charlie's input",
      );
      await charlie.locator('[role="textbox"][aria-label="Message input"]').press('Escape');
      await waitFor(async () => (await tabs.count()) === 3 && (await tab('Charlie').count()) === 0, 10_000, 'Charlie to close on Escape');
      await waitFor(async () => (await active.getAttribute('data-panel-id')) === bravo, 5000, 'Bravo back');
    } finally {
      await other.close();
    }
    return 'replaced, closed on leaving and on Escape, kept by a double click on the tab and on the row; the rewind picker on Shift+Escape only';
  },
);

await step("a conversation of another folder, found by searching all folders, opens in that folder's window", async () => {
  // An instance of its own, whose Claude Code folder holds a session of another folder.
  const own = path.join(runDir, 'elsewhere');
  const ownData = path.join(own, 'data');
  const here = path.join(own, 'here');
  const there = path.join(own, 'there');
  const claudeDir = path.join(own, 'claude');
  const project = path.join(claudeDir, 'projects', there.replace(/[^a-zA-Z0-9]/g, '-'));
  for (const dir of [ownData, here, there, project]) mkdirSync(dir, { recursive: true });
  const id = 'd4d4d4d4-0000-4000-8000-000000000004';
  const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
  writeFileSync(
    path.join(project, `${id}.jsonl`),
    [
      {
        type: 'user',
        uuid: 'w-u',
        parentUuid: null,
        sessionId: id,
        timestamp: at(60),
        cwd: there,
        message: { role: 'user', content: 'When should I water the basil?' },
      },
      {
        type: 'assistant',
        uuid: 'w-a',
        parentUuid: 'w-u',
        sessionId: id,
        timestamp: at(50),
        cwd: there,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Every other morning.' }] },
      },
      { type: 'ai-title', aiTitle: 'Watering plan', sessionId: id },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(ownData, 'settings.json'),
    JSON.stringify({
      'claudeCode.hideOnboarding': true,
      'claudeCode.disableLoginPrompt': true,
      'vilaus.language': 'en',
      'vilaus.extension.autoUpdate': false,
    }),
    'utf8',
  );
  const other = await electron.launch({
    executablePath: executable,
    args: appArgs('--user-data-dir', ownData, '--folder', here, '--secondary-display'),
    cwd: root,
    env: { ...env, CLAUDE_CONFIG_DIR: claudeDir, VILAUS_SESSIONS_DIR: path.join(claudeDir, 'projects') },
    timeout: 60_000,
  });
  try {
    const otherPage = await other.firstWindow();
    const titles = () => other.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.getTitle()));
    await otherPage.locator('.search-box-open').click();
    const filter = otherPage.locator('.quick-input-filter');
    await filter.waitFor({ timeout: 10_000 });
    await filter.fill('basil');
    // Not this folder's: the search offers to widen.
    const widen = otherPage.locator('.quick-input-item', { hasText: 'Search Conversations in All Folders' });
    await widen.waitFor({ timeout: 10_000 });
    const found = otherPage.locator('.quick-input-item', { hasText: 'Watering plan' });
    if ((await found.count()) !== 0) throw new Error("found among this folder's conversations");
    await widen.click();
    await found.waitFor({ timeout: 10_000 });
    const description = await found.locator('.quick-input-description').innerText();
    if (!description.includes('there')) throw new Error(`the result does not say its folder: "${description}"`);
    await found.click();
    // That folder's window, showing the conversation (the extension read it from its folder).
    const wanted = `Watering plan - ${windowTitle(there)}`;
    await waitFor(async () => (await titles()).includes(wanted), 30_000, `a window "${wanted}"`);
    const all = await titles();
    if (!all.some((title) => showsFolder(title, here))) throw new Error(`the first window is gone: ${JSON.stringify(all)}`);
    return `windows: ${all.join(' | ')}`;
  } finally {
    await other.close();
  }
});

await step(
  "files a conversation links to: Shift+click opens one with its program; right-click shows the shell's menu (editor, program, File Explorer, paths, link); web links keep the page's menu",
  async () => {
    // An instance of its own, opened on a session whose transcript links to a file three ways.
    const own = path.join(runDir, 'file-links');
    const ownData = path.join(own, 'data');
    const ownWorkspace = path.join(own, 'workspace');
    const claudeDir = path.join(own, 'claude');
    const project = path.join(claudeDir, 'projects', ownWorkspace.replace(/[^a-zA-Z0-9]/g, '-'));
    for (const folder of [ownData, ownWorkspace, project]) mkdirSync(folder, { recursive: true });
    const notes = path.join(ownWorkspace, 'notes.md');
    writeFileSync(notes, '# Notes\n', 'utf8');
    const sessionId = 'f1f1f1f1-0000-4000-8000-000000000001';
    const line = (fields) => ({ sessionId, cwd: ownWorkspace, timestamp: new Date().toISOString(), ...fields });
    writeFileSync(
      path.join(project, `${sessionId}.jsonl`),
      [
        line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Look at @notes.md please' } }),
        line({
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: notes.replace(/\\/g, '/') } }],
          },
        }),
        line({
          type: 'user',
          uuid: 'u2',
          parentUuid: 'a1',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '# Notes' }] },
        }),
        line({
          type: 'assistant',
          uuid: 'a2',
          parentUuid: 'u2',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'See [the notes](notes.md) and [the site](https://example.com/).' }],
          },
        }),
        { type: 'ai-title', aiTitle: 'Links session', sessionId },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
      'utf8',
    );
    writeFileSync(
      path.join(ownData, 'settings.json'),
      JSON.stringify({
        'claudeCode.hideOnboarding': true,
        'claudeCode.disableLoginPrompt': true,
        'vilaus.language': 'en',
        'vilaus.extension.autoUpdate': false,
      }),
      'utf8',
    );
    const other = await electron.launch({
      executablePath: executable,
      args: appArgs('--user-data-dir', ownData, '--folder', ownWorkspace, '--secondary-display', '--session', sessionId),
      cwd: root,
      env: { ...env, CLAUDE_CONFIG_DIR: claudeDir, VILAUS_SESSIONS_DIR: path.join(claudeDir, 'projects') },
      timeout: 60_000,
    });
    try {
      const otherPage = await other.firstWindow();
      // Nothing opens for real: main's shell, clipboard and menus record instead.
      await other.evaluate(({ shell, clipboard, Menu }) => {
        globalThis.vilausDone = [];
        shell.openPath = async (target) => {
          globalThis.vilausDone.push(`open ${target}`);
          return '';
        };
        shell.showItemInFolder = (target) => globalThis.vilausDone.push(`reveal ${target}`);
        clipboard.writeText = (text) => globalThis.vilausDone.push(`copy ${text}`);
        Menu.prototype.popup = function () {
          globalThis.vilausLastMenu = this;
        };
      });
      const done = () => other.evaluate(() => globalThis.vilausDone);
      const menuLabels = () =>
        other.evaluate(() => globalThis.vilausLastMenu?.items.map((item) => (item.type === 'separator' ? '---' : item.label)));
      const choose = (label) =>
        other.evaluate((_electron, label) => {
          const menu = globalThis.vilausLastMenu;
          delete globalThis.vilausLastMenu;
          menu.items.find((item) => item.label === label).click();
        }, label);
      const conversation = await waitFor(
        async () => {
          for (const frame of otherPage.frames()) {
            if (
              frame.url().startsWith('ccw://wv') &&
              (await frame
                .locator('a', { hasText: 'the notes' })
                .count()
                .catch(() => 0)) === 1
            )
              return frame;
          }
          return undefined;
        },
        30_000,
        'the conversation with its links',
      );
      const markdownLink = conversation.locator('a', { hasText: 'the notes' });
      const mention = conversation.locator('[class*="mentionChip_"][role="button"]');
      const toolFile = conversation.locator('[class*="toolNameTextSecondary_"] a');
      const tabs = otherPage.locator('#content-pane .content-tab');

      // Shift+click: with its program, and the editor does not open it.
      await markdownLink.click({ modifiers: ['Shift'] });
      await waitFor(async () => (await done()).includes(`open ${notes}`), 5000, 'notes.md opened with its program');
      await otherPage.waitForTimeout(500);
      if ((await tabs.count()) !== 0) throw new Error('Shift+click opened the file in the editor too');

      // Right-click on the tool call's file name: the shell's menu.
      await toolFile.click({ button: 'right' });
      const fileMenu = await waitFor(menuLabels, 5000, 'the menu');
      const expected = 'Open in Editor,Open with Default Program,Reveal in File Explorer,---,Copy Path,Copy Relative Path';
      if (fileMenu.join() !== expected) throw new Error(`the menu: ${fileMenu.join()}`);
      await choose('Reveal in File Explorer');
      await waitFor(async () => (await done()).includes(`reveal ${notes}`), 5000, 'notes.md shown in File Explorer');

      // The mention: its path relative to the workspace.
      await mention.click({ button: 'right' });
      await waitFor(menuLabels, 5000, 'the menu');
      await choose('Copy Relative Path');
      await waitFor(async () => (await done()).includes('copy notes.md'), 5000, 'the relative path copied');

      // A Markdown link also copies its link; Open in Editor opens it as a plain click does.
      await markdownLink.click({ button: 'right' });
      const linkMenu = await waitFor(menuLabels, 5000, 'the menu');
      if (!linkMenu.join().endsWith('---,Copy Link')) throw new Error(`the link's menu: ${linkMenu.join()}`);
      await choose('Open in Editor');
      await waitFor(
        async () => (await tabs.count()) === 1 && (await tabs.first().innerText()).includes('notes.md'),
        10_000,
        'notes.md in the editor',
      );

      // A web link is no file: the page keeps its own menu, the shell shows none.
      await conversation.locator('a', { hasText: 'the site' }).click({ button: 'right' });
      await otherPage.waitForTimeout(500);
      if (await menuLabels()) throw new Error(`a web link got the shell's menu: ${(await menuLabels()).join()}`);
      if ((await done()).some((entry) => entry.includes('example.com'))) throw new Error('right-clicking the web link opened it');
      return (await done()).join('; ');
    } finally {
      await other.close();
    }
  },
);

await step(
  'a long conversation: a thinking summary stays where it was clicked; markers by the scrollbar list your messages and go to one; the setting hides them; Go to Previous / Next Message',
  async () => {
    // An instance of its own, on a session of 14 turns, each with a thinking block.
    const own = path.join(runDir, 'long-conversation');
    const ownData = path.join(own, 'data');
    const ownWorkspace = path.join(own, 'workspace');
    const claudeDir = path.join(own, 'claude');
    const project = path.join(claudeDir, 'projects', ownWorkspace.replace(/[^a-zA-Z0-9]/g, '-'));
    for (const folder of [ownData, ownWorkspace, project]) mkdirSync(folder, { recursive: true });
    const sessionId = 'd4d4d4d4-0000-4000-8000-000000000001';
    const paragraphs = (count, words) =>
      Array.from({ length: count }, (_, i) => `${words} line ${i + 1} of the paragraph, with some more words to wrap.`).join('\n\n');
    const entries = [];
    for (let turn = 1; turn <= 14; turn++) {
      const common = { sessionId, cwd: ownWorkspace, timestamp: new Date().toISOString() };
      entries.push({
        ...common,
        type: 'user',
        uuid: `u${turn}`,
        parentUuid: turn === 1 ? null : `a${turn - 1}`,
        message: { role: 'user', content: `Question ${turn}: tell me about topic ${turn}` },
      });
      entries.push({
        ...common,
        type: 'assistant',
        uuid: `a${turn}`,
        parentUuid: `u${turn}`,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: paragraphs(8, `Thinking ${turn}`), signature: 'x' },
            { type: 'text', text: paragraphs(6, `Answer ${turn}`) },
          ],
        },
      });
    }
    entries.push({ type: 'ai-title', aiTitle: 'Long session', sessionId });
    writeFileSync(path.join(project, `${sessionId}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
    const ownSettings = path.join(ownData, 'settings.json');
    const baseSettings = {
      'claudeCode.hideOnboarding': true,
      'claudeCode.disableLoginPrompt': true,
      'vilaus.language': 'en',
      'vilaus.extension.autoUpdate': false,
    };
    writeFileSync(ownSettings, JSON.stringify(baseSettings), 'utf8');
    const other = await electron.launch({
      executablePath: executable,
      args: appArgs('--user-data-dir', ownData, '--folder', ownWorkspace, '--secondary-display', '--session', sessionId),
      cwd: root,
      env: { ...env, CLAUDE_CONFIG_DIR: claudeDir, VILAUS_SESSIONS_DIR: path.join(claudeDir, 'projects') },
      timeout: 60_000,
    });
    try {
      const otherPage = await other.firstWindow();
      const conversation = await waitFor(
        async () => {
          for (const frame of otherPage.frames()) {
            if (
              frame.url().startsWith('ccw://wv') &&
              (await frame
                .locator('summary')
                .count()
                .catch(() => 0)) === 14
            )
              return frame;
          }
          return undefined;
        },
        30_000,
        'the long conversation',
      );
      // At the bottom, the last thinking summary clicked: every block opens, the summary stays put.
      const summary = conversation.locator('summary').last();
      await conversation.evaluate(() => {
        const container = document.querySelector('[class*="messagesContainer_"]');
        container.scrollTop = container.scrollHeight;
      });
      await otherPage.waitForTimeout(500);
      const before = (await summary.boundingBox()).y;
      await summary.click();
      await waitFor(async () => (await conversation.locator('details[open]').count()) === 14, 5000, 'every thinking block open');
      await otherPage.waitForTimeout(1600);
      const after = (await summary.boundingBox()).y;
      if (Math.abs(after - before) > 2) throw new Error(`the summary moved from ${before} to ${after}`);

      // The markers: one bar per message of the user's, the list on pointing, a click goes there.
      const state = () =>
        conversation.evaluate(() => ({
          shown: !document.querySelector('.vilaus-markers').hidden,
          bars: document.querySelectorAll('.vilaus-marker-bar').length,
          current: Number(document.querySelector('.vilaus-marker-bar.current')?.dataset.index),
        }));
      await waitFor(async () => (await state()).bars === 14, 5000, 'a bar per message');
      await conversation.locator('.vilaus-markers-bars').hover();
      const items = conversation.locator('.vilaus-marker-item');
      await waitFor(async () => (await items.count()) === 14, 5000, 'the list of messages');
      if ((await items.nth(2).innerText()) !== 'Question 3: tell me about topic 3')
        throw new Error(`the third item: ${await items.nth(2).innerText()}`);
      await items.nth(2).click();
      await waitFor(async () => (await state()).current === 2, 5000, 'the third message in view');

      // Commands: the next and the previous message.
      const runOtherCommand = async (title) => {
        await other.evaluate(({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['control', 'shift'] });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: ['control', 'shift'] });
        });
        const filter = otherPage.locator('.quick-input-filter');
        await filter.waitFor({ timeout: 5000 });
        await filter.fill(`>${title}`);
        await waitFor(async () => (await otherPage.locator('.quick-input-item').count()) === 1, 5000, `the command ${title}`);
        await filter.press('Enter');
      };
      await runOtherCommand('Go to Next Message of Yours');
      await waitFor(async () => (await state()).current === 3, 5000, 'the fourth message in view');
      await runOtherCommand('Go to Previous Message of Yours');
      await waitFor(async () => (await state()).current === 2, 5000, 'the third message again');

      // The setting hides them, and shows them again.
      writeFileSync(ownSettings, JSON.stringify({ ...baseSettings, 'vilaus.conversations.messageMarkers': false }), 'utf8');
      await waitFor(async () => !(await state()).shown, 5000, 'the markers hidden');
      writeFileSync(ownSettings, JSON.stringify(baseSettings), 'utf8');
      await waitFor(async () => (await state()).shown, 5000, 'the markers back');
      return `summary at ${before} px before and after`;
    } finally {
      await other.close();
    }
  },
);

await step(
  "the conversation's own text: a selection in Claude's reply, its thinking or your message offers Comment (Ctrl+Alt+M too); the text stays highlighted; its source scrolls there and flashes it; a click into the page closes an untouched form",
  async () => {
    // An instance of its own, on a session of 6 turns, each with thinking and a reply.
    const own = path.join(runDir, 'conversation-comments');
    const ownData = path.join(own, 'data');
    const ownWorkspace = path.join(own, 'workspace');
    const claudeDir = path.join(own, 'claude');
    const project = path.join(claudeDir, 'projects', ownWorkspace.replace(/[^a-zA-Z0-9]/g, '-'));
    for (const folder of [ownData, ownWorkspace, project]) mkdirSync(folder, { recursive: true });
    const sessionId = 'e5e5e5e5-0000-4000-8000-000000000001';
    const paragraphs = (count, words) =>
      Array.from({ length: count }, (_, i) => `${words} line ${i + 1} of the paragraph, with some more words to wrap.`).join('\n\n');
    const entries = [];
    for (let turn = 1; turn <= 6; turn++) {
      const common = { sessionId, cwd: ownWorkspace, timestamp: new Date().toISOString() };
      entries.push({
        ...common,
        type: 'user',
        uuid: `u${turn}`,
        parentUuid: turn === 1 ? null : `a${turn - 1}`,
        message: { role: 'user', content: `Question ${turn}: tell me about topic ${turn}` },
      });
      entries.push({
        ...common,
        type: 'assistant',
        uuid: `a${turn}`,
        parentUuid: `u${turn}`,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: paragraphs(3, `Thinking ${turn}`), signature: 'x' },
            { type: 'text', text: paragraphs(5, `Answer ${turn}`) },
          ],
        },
      });
    }
    entries.push({ type: 'ai-title', aiTitle: 'Commented session', sessionId });
    writeFileSync(path.join(project, `${sessionId}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join('\n'), 'utf8');
    writeFileSync(
      path.join(ownData, 'settings.json'),
      JSON.stringify({
        'claudeCode.hideOnboarding': true,
        'claudeCode.disableLoginPrompt': true,
        'vilaus.language': 'en',
        'vilaus.extension.autoUpdate': false,
      }),
      'utf8',
    );
    const other = await electron.launch({
      executablePath: executable,
      args: appArgs('--user-data-dir', ownData, '--folder', ownWorkspace, '--secondary-display', '--session', sessionId),
      cwd: root,
      env: { ...env, CLAUDE_CONFIG_DIR: claudeDir, VILAUS_SESSIONS_DIR: path.join(claudeDir, 'projects') },
      timeout: 60_000,
    });
    try {
      const otherPage = await other.firstWindow();
      const conversation = await waitFor(
        async () => {
          for (const frame of otherPage.frames()) {
            if (
              frame.url().startsWith('ccw://wv') &&
              (await frame
                .locator('summary')
                .count()
                .catch(() => 0)) === 6
            )
              return frame;
          }
          return undefined;
        },
        30_000,
        'the conversation',
      );
      // Selects `text` in the `index`th element `selector` matches, in view, and ends the selection
      // as the mouse does (Playwright's drags in the page select only now and then).
      const select = (selector, index, text) =>
        conversation.evaluate(
          ([selector, index, text]) => {
            const walker = document.createTreeWalker(document.querySelectorAll(selector)[index], NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const at = node.data.indexOf(text);
              if (at >= 0) {
                node.parentElement.scrollIntoView({ block: 'center' });
                const range = document.createRange();
                range.setStart(node, at);
                range.setEnd(node, at + text.length);
                getSelection().removeAllRanges();
                getSelection().addRange(range);
                window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
                return;
              }
            }
            throw new Error(`no "${text}" in ${selector}`);
          },
          [selector, index, text],
        );
      const button = conversation.locator('.vilaus-comment-button');
      const form = otherPage.locator('.comment-form-overlay .comment-form');
      const formSource = async () => {
        await form.waitFor({ timeout: 5000 });
        return form.locator('.comment-form-source').innerText();
      };
      const submit = async (text) => {
        await form.locator('.comment-form-input').fill(text);
        await form.locator('.comment-form-input').press('Enter');
        await waitFor(async () => (await form.count()) === 0, 5000, 'the form to close');
      };
      const blocks = conversation.locator('.vilaus-comments .vilaus-comment');
      const highlighted = () =>
        conversation.evaluate(() =>
          [...(CSS.highlights.get('vilaus-comment') ?? [])]
            .map((range) => (range instanceof Range ? range.toString() : ''))
            .sort()
            .join(' | '),
        );

      // Claude's reply, by the Comment button. The page shows the messages a moment after they are
      // there (extension 2.1.306 holds them for its plugins), and a selection's text is what it shows.
      await waitFor(
        () =>
          conversation.evaluate(() =>
            [...document.querySelectorAll('[data-transcript-message]')].every(
              (message) => getComputedStyle(message).visibility === 'visible',
            ),
          ),
        10_000,
        'the messages shown',
      );
      await select('[data-bookmark-uuid="a2"]', 0, 'Answer 2 line 3');
      await waitFor(() => button.isVisible(), 5000, 'the Comment button');
      await button.click();
      if ((await formSource()) !== "Claude's reply") throw new Error(`the form says ${await formSource()}`);
      await submit('Why line 3?');
      await waitFor(async () => (await blocks.count()) === 1, 5000, 'a block');
      await waitFor(async () => (await highlighted()) === 'Answer 2 line 3', 5000, 'the reply highlighted');

      // The user's message, by Ctrl+Alt+M with the focus in the page.
      await conversation.locator('[class*="messagesContainer_"]').focus();
      await select('[class*="userMessage_"]', 2, 'topic 3');
      await other.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers: ['control', 'alt'] });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers: ['control', 'alt'] });
      });
      if ((await formSource()) !== 'Your message') throw new Error(`the form says ${await formSource()}`);
      await submit('I meant topic 4.');

      // Thinking, open, by the button; then closed again.
      await conversation.locator('summary').nth(3).click();
      await waitFor(async () => (await conversation.locator('details[open]').count()) === 6, 5000, 'the thinking open');
      await select('[class*="thinkingContent_"]', 3, 'Thinking 4 line 2');
      await waitFor(() => button.isVisible(), 5000, 'the Comment button');
      await button.click();
      if ((await formSource()) !== "Claude's thinking") throw new Error(`the form says ${await formSource()}`);
      await submit('Good point.');
      await conversation.locator('summary').nth(3).click();
      await waitFor(async () => (await conversation.locator('details[open]').count()) === 0, 5000, 'the thinking closed');
      // The clicked summary is kept in place for 1.5 s, against scrolling done by a script too.
      await otherPage.waitForTimeout(1600);
      const all = 'Answer 2 line 3 | Thinking 4 line 2 | topic 3';
      await waitFor(async () => (await highlighted()) === all, 5000, 'the three texts highlighted');

      // A source scrolls to its text and flashes it; closed thinking opens first.
      const scroller = '[class*="messagesContainer_"]';
      const toBottom = () => conversation.evaluate((scroller) => (document.querySelector(scroller).scrollTop = 1e6), scroller);
      const inView = (text) =>
        conversation.evaluate(
          ([scroller, text]) => {
            const range = [...(CSS.highlights.get('vilaus-comment') ?? [])].find(
              (candidate) => candidate instanceof Range && candidate.toString() === text,
            );
            const shown = range?.getBoundingClientRect();
            const view = document.querySelector(scroller).getBoundingClientRect();
            return shown !== undefined && shown.height > 0 && shown.top >= view.top && shown.bottom <= view.bottom;
          },
          [scroller, text],
        );
      const flashed = () => conversation.evaluate(() => [...(CSS.highlights.get('vilaus-comment-flash') ?? [])].map(String).join());
      const source = (label) => blocks.locator('.vilaus-comment-source', { hasText: label });
      await toBottom();
      await otherPage.waitForTimeout(300);
      if (await inView('Answer 2 line 3')) throw new Error('the reply is in view at the bottom already');
      if ((await source("Claude's reply").getAttribute('title')) !== 'Show in the conversation')
        throw new Error('the source has no tooltip');
      await source("Claude's reply").click();
      await waitFor(async () => (await flashed()) === 'Answer 2 line 3', 1000, 'the reply flashed');
      await waitFor(() => inView('Answer 2 line 3'), 5000, 'the reply in view');
      await toBottom();
      await otherPage.waitForTimeout(300);
      await source("Claude's thinking").click();
      await waitFor(async () => (await conversation.locator('details[open]').count()) === 6, 5000, 'the thinking opened');
      await waitFor(() => inView('Thinking 4 line 2'), 5000, 'the thinking in view');

      // A click into the page closes the form while nothing is typed in it.
      await select('[data-bookmark-uuid="a5"]', 0, 'Answer 5 line 1');
      await waitFor(() => button.isVisible(), 5000, 'the Comment button');
      await button.click();
      await form.waitFor({ timeout: 5000 });
      await conversation.locator('[data-bookmark-uuid="a5"] p', { hasText: 'Answer 5 line 2' }).click();
      await waitFor(async () => (await form.count()) === 0, 5000, 'the form closed by the click');

      // Clearing the comments takes the highlights away.
      await conversation.locator('.vilaus-comments [data-action="clear"]').click();
      await waitFor(async () => (await blocks.count()) === 0 && (await highlighted()) === '', 5000, 'no comments, no highlights');
      return all;
    } finally {
      await other.close();
    }
  },
);

await step(
  "files dropped onto the window: the session list mentions them in the conversation (copied into the workspace when outside it), the conversation attaches them, the content pane (hidden: a strip at the conversation's right) opens them, the title bar takes none; while dragged, the window shows which does what",
  async () => {
    // An instance of its own, on a short session; files outside its workspace and one inside.
    const own = path.join(runDir, 'file-drop');
    const ownData = path.join(own, 'data');
    const ownWorkspace = path.join(own, 'workspace');
    const outside = path.join(own, 'outside');
    const claudeDir = path.join(own, 'claude');
    const project = path.join(claudeDir, 'projects', ownWorkspace.replace(/[^a-zA-Z0-9]/g, '-'));
    for (const folder of [ownData, ownWorkspace, path.join(outside, 'folder'), project]) mkdirSync(folder, { recursive: true });
    const notes = path.join(outside, 'notes.txt');
    writeFileSync(notes, 'notes\n', 'utf8');
    writeFileSync(path.join(outside, 'folder', 'inner.txt'), 'inner\n', 'utf8');
    writeFileSync(path.join(ownWorkspace, 'inside.txt'), 'inside\n', 'utf8');
    const sessionId = 'f6f6f6f6-0000-4000-8000-000000000001';
    const common = { sessionId, cwd: ownWorkspace, timestamp: new Date().toISOString() };
    writeFileSync(
      path.join(project, `${sessionId}.jsonl`),
      [
        { ...common, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'Hello' } },
        {
          ...common,
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
        },
        { type: 'ai-title', aiTitle: 'Drop session', sessionId },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
      'utf8',
    );
    const ownSettings = path.join(ownData, 'settings.json');
    const baseSettings = {
      'claudeCode.hideOnboarding': true,
      'claudeCode.disableLoginPrompt': true,
      'vilaus.language': 'en',
      'vilaus.extension.autoUpdate': false,
    };
    writeFileSync(ownSettings, JSON.stringify(baseSettings), 'utf8');
    const other = await electron.launch({
      executablePath: executable,
      args: appArgs('--user-data-dir', ownData, '--folder', ownWorkspace, '--secondary-display', '--session', sessionId),
      cwd: root,
      env: { ...env, CLAUDE_CONFIG_DIR: claudeDir, VILAUS_SESSIONS_DIR: path.join(claudeDir, 'projects') },
      timeout: 60_000,
    });
    try {
      const otherPage = await other.firstWindow();
      const conversation = await waitFor(
        async () => {
          for (const frame of otherPage.frames()) {
            if (
              frame.url().startsWith('ccw://wv') &&
              (await frame
                .locator('[data-bookmark-uuid="a1"]')
                .count()
                .catch(() => 0)) === 1
            )
              return frame;
          }
          return undefined;
        },
        30_000,
        'the conversation',
      );
      const input = conversation.locator('[role="textbox"][aria-label="Message input"]');
      const overlay = () =>
        otherPage.evaluate(() =>
          document.querySelector('.file-drop')?.hidden === false
            ? [...document.querySelectorAll('.file-drop-zone')]
                .map((zone) => `${zone.dataset.action}${zone.classList.contains('active') ? '*' : ''}`)
                .join(' ')
            : '',
        );
      // A drag as the system makes one, with real files; driven this way, it stays in the page it
      // starts in. Returns what the window showed before the last step (a drop, or a cancel).
      const cdp = await otherPage.context().newCDPSession(otherPage);
      let lastDetails = '';
      const drag = async (files, moves, end = 'drop') => {
        const data = { items: [], files, dragOperationsMask: 1 };
        const [x0, y0] = moves[0];
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
        await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: x0, y: y0, data });
        for (const [x, y] of moves) await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
        await otherPage.waitForTimeout(150);
        const shown = await overlay();
        lastDetails = await otherPage.evaluate(() =>
          [...document.querySelectorAll('.file-drop-detail')].map((detail) => detail.textContent).join(' | '),
        );
        const [x, y] = moves.at(-1);
        await cdp.send('Input.dispatchDragEvent', { type: end, x, y, data });
        return shown;
      };
      const center = async (selector) => {
        const box = await otherPage.locator(selector).boundingBox();
        return [box.x + box.width / 2, box.y + box.height / 2];
      };
      const titleBar = [20, 20];
      const attachments = path.join(ownWorkspace, 'attachments');

      // Onto the session list: copied into the workspace and mentioned.
      let shown = await drag([notes], [titleBar, await center('#sidebar')]);
      if (shown !== 'mention* attach open') throw new Error(`over the session list the window shows ${shown}`);
      await waitFor(async () => (await input.innerText()).includes('@attachments/notes.txt'), 5000, 'the mention in the input');
      if (readFileSync(path.join(attachments, 'notes.txt'), 'utf8') !== 'notes\n') throw new Error('the copy differs');
      if ((await overlay()) !== '') throw new Error('the window still shows the places after the drop');

      // Again: a file (a free name), a folder (whole), a file of the workspace (not copied).
      await drag([notes, path.join(outside, 'folder'), path.join(ownWorkspace, 'inside.txt')], [titleBar, await center('#sidebar')]);
      await waitFor(async () => (await input.innerText()).includes('@inside.txt'), 5000, 'the three mentions');
      const mentioned = await input.innerText();
      for (const expected of ['attachments/notes (1).txt', '@attachments/folder', '@inside.txt'])
        if (!mentioned.includes(expected)) throw new Error(`the input lacks ${expected}: ${mentioned}`);
      if (!existsSync(path.join(attachments, 'folder', 'inner.txt'))) throw new Error('the folder was not copied whole');
      if (existsSync(path.join(attachments, 'inside.txt'))) throw new Error('a file of the workspace was copied');

      // The title bar (its search box too) takes nothing.
      shown = await drag([notes], [titleBar, await center('#titlebar-center')]);
      if (shown !== 'mention attach open') throw new Error(`over the search box the window shows ${shown}`);
      await otherPage.waitForTimeout(500);
      if (readdirSync(attachments).length !== 3)
        throw new Error(`a drop on the search box did something: ${readdirSync(attachments).join(', ')}`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: titleBar[0] + 30, y: titleBar[1] });

      // Onto the conversation: the page attaches it, the shell lets it through.
      await input.fill('');
      const conversationBox = await otherPage.locator('#main').boundingBox();
      const [cx, cy] = [conversationBox.x + conversationBox.width / 3, conversationBox.y + conversationBox.height / 2];
      shown = await drag(
        [notes],
        [
          [cx, cy - 100],
          [cx + 10, cy - 100],
        ],
      );
      if (shown !== 'mention attach* open') throw new Error(`over the conversation the window shows ${shown}`);
      await waitFor(async () => (await conversation.locator('form').innerText()).includes('notes.txt'), 5000, 'the attachment');
      await waitFor(async () => (await overlay()) === '', 5000, 'the places gone after the drop on the page');

      // The content pane hidden: a strip at the conversation's right opens it in the editor.
      if (await otherPage.locator('#content-pane').isVisible()) throw new Error('the content pane shows already');
      shown = await drag([notes], [titleBar, [conversationBox.x + conversationBox.width - 40, cy]]);
      if (shown !== 'mention attach open*') throw new Error(`over the conversation's right edge the window shows ${shown}`);
      const tab = (name) => otherPage.locator('#content-pane .content-tab', { hasText: name });
      await waitFor(async () => (await tab('notes.txt').count()) === 1, 10_000, 'the tab');

      // The content pane shown: it opens them.
      await waitFor(() => otherPage.locator('#content-pane').isVisible(), 5000, 'the content pane');
      shown = await drag([path.join(ownWorkspace, 'inside.txt')], [titleBar, await center('#content-pane')]);
      if (shown !== 'mention attach open*') throw new Error(`over the content pane the window shows ${shown}`);
      await waitFor(async () => (await tab('inside.txt').count()) === 1, 10_000, 'the second tab');

      // A cancelled drag: the places go once the mouse moves again, over the shell's page or the
      // conversation's. (A real cancel also leaves the pages, which takes them away at once; the
      // protocol's cancel does not reach them.)
      for (const { label, at, moved } of [
        { label: 'the title bar', at: titleBar, moved: [titleBar[0] + 30, titleBar[1]] },
        { label: 'the conversation', at: [cx, cy - 100], moved: [cx + 30, cy - 80] },
      ]) {
        shown = await drag([notes], [at, [at[0] + 10, at[1]]], 'dragCancel');
        if (!shown.includes('mention')) throw new Error(`during the drag over ${label} the window shows ${shown}`);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: moved[0], y: moved[1] });
        await waitFor(async () => (await overlay()) === '', 5000, `the places gone after the cancel over ${label}`);
      }

      // The folder copies go to is a setting; the session list's label names it.
      writeFileSync(ownSettings, JSON.stringify({ ...baseSettings, 'vilaus.conversations.attachmentsFolder': 'inbox' }), 'utf8');
      await waitFor(
        async () => {
          await drag([notes], [titleBar, await center('#sidebar')], 'dragCancel');
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: titleBar[0] + 30, y: titleBar[1] });
          return lastDetails.includes('workspace/inbox');
        },
        5000,
        'the label to name the new folder',
      );
      await drag([notes], [titleBar, await center('#sidebar')]);
      await waitFor(() => existsSync(path.join(ownWorkspace, 'inbox', 'notes.txt')), 5000, 'the copy in the new folder');
      return `copies: ${readdirSync(attachments).join(', ')}; inbox/notes.txt`;
    } finally {
      await other.close();
    }
  },
);

await step('administrator instance: runs next to the normal one, says so, and reads the API keys the normal one stored', async () => {
  const stored = readJson(path.join(dataDir, 'providers.json'))?.keys?.mock;
  if (!stored) throw new Error('the normal instance stored no key');
  const adminWorkspace = path.join(runDir, 'admin-workspace');
  mkdirSync(adminWorkspace, { recursive: true });
  const admin = await electron.launch({
    executablePath: executable,
    args: appArgs('--user-data-dir', dataDir, '--folder', adminWorkspace, '--secondary-display'),
    cwd: root,
    env: { ...env, VILAUS_ELEVATED: '1' },
    timeout: 60_000,
  });
  let title;
  try {
    const adminPage = await admin.firstWindow();
    // The search box says so after the folder's name.
    await adminPage.locator('.search-box-administrator', { hasText: /\[(Administrator|管理员)\]/ }).waitFor({ timeout: 30_000 });
    // The display language is Chinese by now (an earlier step switched it).
    title = await waitFor(
      async () => {
        const titles = await admin.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
        return titles.find((candidate) => / \[(Administrator|管理员)\]$/.test(candidate));
      },
      10_000,
      'the window title to say so',
    );
    // safeStorage there decrypts what the normal instance encrypted: one key for both.
    const key = await admin.evaluate(({ safeStorage }, data) => safeStorage.decryptString(Buffer.from(data, 'base64')), stored);
    if (key !== 'test-key-123') throw new Error(`decrypted "${key}"`);
    // The folder opened as administrator is among the normal instance's recent folders too.
    await waitFor(
      async () => {
        const recent = await page.evaluate(() => window.vilausNative.invoke('window.recentFolders'));
        return recent.some((folder) => folder.toLowerCase() === adminWorkspace.toLowerCase());
      },
      10_000,
      "the administrator's folder in the normal instance's recent folders",
    );
    // The normal instance is still there.
    await page.title();
  } finally {
    await admin.close();
  }
  for (const own of [
    ['state', 'shell.json'],
    ['chromium', 'Local State'],
  ]) {
    if (!existsSync(path.join(dataDir, 'admin', ...own))) throw new Error(`no admin\\${own.join('\\')}`);
  }
  return `${title}; the key is shared`;
});

// Last on purpose: the versions installed here become current at the next starts of this data folder.
await step('Extension Version in settings: Check for Updates installs from Open VSX; a VSIX of someone else is refused', async () => {
  const vsix = readFileSync(makeVsix('9.0.0'));
  const sha256 = createHash('sha256').update(vsix).digest('hex');
  let base = '';
  const openVsx = createServer((request, response) => {
    if (request.url === '/api/anthropic/claude-code/win32-x64') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          namespace: 'Anthropic',
          name: 'claude-code',
          version: '9.0.0',
          targetPlatform: 'win32-x64',
          files: { download: `${base}/package.vsix`, sha256: `${base}/package.sha256` },
        }),
      );
    } else if (request.url === '/package.vsix') {
      response.writeHead(200, { 'content-length': vsix.length }).end(vsix);
    } else if (request.url === '/package.sha256') {
      response.end(sha256);
    } else {
      response.writeHead(404).end();
    }
  });
  base = `http://127.0.0.1:${await listenOnSafePort(openVsx)}`;
  try {
    const { main, widget } = await openExtensionVersion();
    await main.evaluate((url) => window.vilausNative.invoke('settings.update', { key: 'vilaus.extension.openVsxUrl', value: url }), base);
    const current = await widget.locator('.extension-version-current').innerText();
    const running = /^Claude Code (\S+)$/.exec(current)?.[1];
    if (!running) throw new Error(`the version in use reads "${current}"`);
    const status = widget.locator('.extension-version-status');

    // The display language is Chinese by now (an earlier step switched it): find by class.
    await widget.locator('.extension-version-check').click();
    await waitFor(
      async () => (await widget.locator('.extension-version-pending').isVisible()) && (await status.innerText()).includes('9.0.0'),
      60_000,
      'the update to be downloaded and installed',
    );
    // VSCodium's copy, the one running, is backed up as the version to go back to.
    const state = readExtensionState();
    if (state.pending !== '9.0.0' || state.previous !== running) throw new Error(`state.json: ${JSON.stringify(state)}`);

    // The file picker answers with a package from another publisher.
    const other = makeVsix('9.0.1', 'someone');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, other);
    await widget.locator('.extension-version-install').click();
    const refused = /not the Claude Code extension|不是 Claude Code 插件/;
    await waitFor(async () => refused.test(await status.innerText()), 15_000, 'the refusal');
    const after = readExtensionState();
    if (after.pending !== '9.0.0') throw new Error(`state.json after the refusal: ${JSON.stringify(after)}`);
    await main.screenshot({ path: path.join(runDir, 'extension-version.png') });
    return `${current}; pending ${state.pending}, backed up ${state.previous}`;
  } finally {
    openVsx.close();
  }
});

await step('after a restart the update runs; Go Back and Restart returns to the backed-up copy, which works', async () => {
  const before = readExtensionState();
  const backup = before.previous;
  if (!backup) throw new Error(`nothing backed up: ${JSON.stringify(before)}`);
  const restart = async () => {
    app = await electron.launch({
      executablePath: executable,
      args: appArgs('--user-data-dir', dataDir, '--secondary-display'),
      cwd: root,
      env,
      timeout: 60_000,
    });
    page = await app.firstWindow();
  };
  await app.close();
  await restart();
  const { widget } = await openExtensionVersion();
  const updated = await widget.locator('.extension-version-current').innerText();
  if (updated !== 'Claude Code 9.0.0') throw new Error(`after the restart: "${updated}"`);
  const previous = await widget.locator('.extension-version-previous').innerText();
  if (!previous.includes(backup)) throw new Error(`the version before reads "${previous}"`);
  const button = widget.locator('.extension-version-rollback');
  if (await button.isDisabled()) throw new Error('Go Back is disabled');

  // The test restarts the app itself: Go Back's restart just quits.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.relaunch = () => {};
  });
  const closed = app.waitForEvent('close', { timeout: 30_000 });
  await button.click();
  await closed;
  const rolledBack = readExtensionState();
  if (rolledBack.pending !== backup || rolledBack.skipped !== '9.0.0') throw new Error(`state.json: ${JSON.stringify(rolledBack)}`);

  // The backed-up copy is the real extension: it activates.
  await restart();
  await waitFor(
    () => {
      const state = readExtensionState();
      return state.current === backup && state.lastGood === backup;
    },
    60_000,
    `Claude Code ${backup} from the backup to activate`,
  );
  const again = await openExtensionVersion();
  const source = await again.widget.locator('.extension-version-source').innerText();
  if (!source.includes(path.join(dataDir, 'extensions'))) throw new Error(`it runs from "${source}"`);
  return `9.0.0 -> ${backup} from ${source}`;
});

await app.close();
releasesServer.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Artifacts: ${runDir}`);
// The extension copies the last steps installed (a few hundred MB): never kept.
rmSync(path.join(dataDir, 'extensions'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
for (const key of [registryTestKey, 'HKCU\\Software\\Vilausity-test']) {
  try {
    // The parent only once no other run keeps a key in it.
    const left = key === registryTestKey ? '' : execFileSync(reg, ['query', key], { windowsHide: true, encoding: 'latin1' });
    if (!left.includes('HKEY_CURRENT_USER\\Software\\Vilausity-test\\')) {
      execFileSync(reg, ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true });
    }
  } catch {
    // Already gone.
  }
}
if (failed === 0) {
  // The extension's processes may hold the folder a moment after the app closed.
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
process.exit(failed === 0 ? 0 : 1);
