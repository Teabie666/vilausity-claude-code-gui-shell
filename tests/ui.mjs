// Shell UI test: keybindings, sidebar, conversation tabs, command palette, themes, find, zoom,
// context menus, restart restore.
// Sends no messages to Claude (no usage).   npm run build && node tests/ui.mjs
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
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

const launch = () =>
  electron.launch({
    executablePath: electronPath,
    // On a second monitor, if there is one, out of the way of whoever started the run.
    args: ['.', '--user-data-dir', dataDir, '--folder', workspace, '--secondary-display'],
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
  await app.evaluate(({ BrowserWindow }, { keyCode, modifiers, title }) => {
    // Shell windows show ccw://app; a tab's own window is a blank page the shell fills.
    const window = BrowserWindow.getAllWindows().find((w) =>
      title
        ? w.webContents.getURL().startsWith('ccw://app/') && (w.getTitle() === title || w.getTitle().endsWith(` - ${title}`))
        : w.webContents.getURL() === 'about:blank',
    );
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, { keyCode, modifiers, title });
}

/**
 * Listens on a free port Chromium agrees to fetch from: it refuses a list of "unsafe" ports
 * (net::ERR_UNSAFE_PORT), and the system hands those out now and then (3659 once did).
 */
const CHROMIUM_UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
  113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
async function listenOnSafePort(server) {
  for (;;) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    if (!CHROMIUM_UNSAFE_PORTS.has(server.address().port)) return server.address().port;
    await new Promise((resolve) => server.close(resolve));
  }
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
  await page.locator('.search-box-open').click();
  const filter = page.locator('.quick-input-filter');
  await filter.waitFor({ timeout: 5000 });
  const row = page.locator('.quick-input-item', { hasText: 'Receipts by month' });
  await row.waitFor({ timeout: 10_000 });
  for (const [query, detail] of [
    ['receipts', undefined],
    ['downloads', 'You: Sort the receipts in Downloads by month'],
    ['ledger.csv', 'Changed: ledger.csv'],
  ]) {
    await filter.fill(query);
    await waitFor(
      async () =>
        (await row.count()) === 1 &&
        (detail === undefined || (await row.locator('.quick-input-detail').innerText()) === detail),
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
});

await step('Ctrl+F finds text in the active conversation', async () => {
  // A just-opened conversation renders its welcome content a moment later (the session list
  // may show the word first, so look in the active conversation).
  await waitFor(async () => {
    const handle = await page.locator('#main .panel:not([hidden]) .webview-frame').elementHandle();
    const frame = await handle?.contentFrame();
    return frame ? frame.evaluate(() => document.body.innerText.includes('Claude')).catch(() => false) : false;
  }, 10_000, 'conversation content');
  await press('Control+F');
  const input = page.locator('.find-input');
  await input.waitFor({ timeout: 5000 });
  await input.fill('Claude');
  const count = await waitFor(async () => {
    const text = await page.locator('.find-count').innerText();
    return /^\d+ of \d+$/.test(text) ? text : undefined;
  }, 5000, 'a match count');
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

await step('right-click in a conversation offers the extension menu; Rename Session Tab runs', () => withRecordedMenus(async () => {
  const labels = await openContextMenu(activeConversation());
  if (labels.filter((label) => conversationMenu.includes(label)).join('|') !== conversationMenu.join('|')) {
    throw new Error(`menu was: ${labels.join(' | ')}`);
  }

  await clickRecordedMenuItem('Rename Session Tab');
  const outcome = await waitFor(async () => {
    if (await page.locator('.quick-input-filter').count()) return 'input box';
    const toast = page.locator('.toast-message');
    return (await toast.count()) ? `message "${await toast.first().innerText()}"` : undefined;
  }, 10_000, 'the rename command to answer');
  if (outcome === 'input box') {
    // The extension's validateInput refuses an empty name; the shell asks again with its message.
    await page.locator('.quick-input-filter').fill('');
    await page.locator('.quick-input-filter').press('Enter');
    const message = await waitFor(async () => {
      const validation = page.locator('.quick-input-validation');
      return (await validation.count()) ? validation.innerText() : undefined;
    }, 5000, 'the validation message');
    await page.locator('.quick-input-filter').press('Escape');
    await waitFor(async () => (await page.locator('.quick-input-filter').count()) === 0, 3000, 'the input box to close');
    return `${labels.length} menu entries; rename asked for a name, empty refused ("${message}"), cancelled`;
  }
  await page.locator('.toast-close').first().click();
  return `${labels.length} menu entries; rename answered with ${outcome}`;
}));

await step('Add Session Tab to Group from the conversation menu shows the group picker', () => withRecordedMenus(async () => {
  await openContextMenu(activeConversation());
  await clickRecordedMenuItem('Add Session Tab to Group');
  const items = await waitFor(async () => {
    const rows = page.locator('.quick-input-item');
    return (await rows.count()) ? rows.allInnerTexts() : undefined;
  }, 10_000, 'the group picker');
  await page.locator('.quick-input-filter').press('Escape');
  await waitFor(async () => (await page.locator('.quick-input-filter').count()) === 0, 3000, 'the picker to close');
  if (!items.some((item) => item.startsWith('New group'))) throw new Error(`picker had: ${items.join(' | ')}`);
  return `picker: ${items.join(' | ')}`;
}));

await step('right-click in the session list does not offer the conversation menu', () => withRecordedMenus(async () => {
  await rightClick(page.locator('#sidebar .webview-frame'));
  await page.waitForTimeout(1000);
  const labels = (await recordedMenu()) ?? [];
  if (labels.some((label) => conversationMenu.includes(label))) throw new Error(`menu was: ${labels.join(' | ')}`);
  return labels.length ? `menu: ${labels.join(' | ')}` : 'no menu';
}));

// ---- content pane and editor ------------------------------------------------------------

const sampleFile = path.join(workspace, 'src', 'sample.ts');
const sampleText = 'export const answer: number = 42;\n// a comment\nfunction greet(name: string) {\n  return `hi ${name}`;\n}\n';
mkdirSync(path.dirname(sampleFile), { recursive: true });
writeFileSync(sampleFile, sampleText, 'utf8');
const contentTabs = () => page.locator('#content-pane .content-tab');
// Monaco renders spaces as no-break spaces.
const editorText = async () =>
  (await page.locator('#content-pane .content-editor:not([hidden]) .view-lines').innerText()).replace(/ /g, ' ');

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
  const colors = await waitFor(async () => {
    const found = await page.evaluate(() => {
      const spans = document.querySelectorAll('#content-pane .view-line span span');
      return [...new Set([...spans].map((span) => getComputedStyle(span).color))];
    });
    return found.length >= 3 ? found : undefined;
  }, 15_000, 'syntax colors');
  await page.screenshot({ path: path.join(runDir, 'editor.png') });
  return `${colors.length} token colors`;
});

await step('the conversation sees the open file (selection sync)', async () => {
  const seen = await waitFor(async () => {
    for (const frame of webviewFrames()) {
      if (await frame.evaluate(() => document.body.innerText.includes('sample.ts')).catch(() => false)) return true;
    }
    return false;
  }, 10_000, 'sample.ts in the chat');
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
  await waitFor(async () => (await page.locator('#content-pane .markdown-preview pre.shiki').count()) === 1, 10_000, 'a highlighted code block');
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
  await waitFor(async () => (await page.locator('#content-pane .content-tab.active .tab-label').innerText()) === 'sample.ts', 5000, 'sample.ts to come forward');
  await waitFor(async () => (await page.locator('#content-pane .content-editor:not([hidden]) .selected-text').count()) > 0, 5000, 'the commented text selected');

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
  await waitFor(async () => (await aux.locator('.aux-body .view-lines').count()) > 0 && (await auxText()).includes('answer'), 10_000, 'the editor in the new window');
  // Monaco's generated styles (token colors) must reach the new window.
  const colors = await waitFor(async () => {
    const count = await aux.evaluate(() => new Set([...document.querySelectorAll('.view-line span span')].map((s) => getComputedStyle(s).color)).size);
    return count >= 3 ? count : undefined;
  }, 10_000, 'syntax colors in the new window');
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === 'about:blank')?.close());
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
  const fontSize = await waitFor(async () => {
    const lines = page.locator('#content-pane .content-editor:not([hidden]) .view-lines');
    const size = (await lines.count()) ? await lines.evaluate((element) => getComputedStyle(element).fontSize) : '';
    return size === '20px' ? size : undefined;
  }, 10_000, 'the editor at 20px');

  // The settings panel stayed open over the editor.
  await settingRow('editor.fontSize').hover();
  await settingRow('editor.fontSize').locator('.setting-reset').click();
  await waitFor(() => readSettings()['editor.fontSize'] === undefined, 5000, 'editor.fontSize removed');
  return `editor ${fontSize}`;
});

await step('settings.json opens in the editor, validated against the settings schema', async () => {
  const original = readFileSync(settingsFile, 'utf8');
  const withError = { ...JSON.parse(original), 'editor.tabSize': 'wide' };
  writeFileSync(settingsFile, JSON.stringify(withError, null, 2), 'utf8');
  await press('Control+,');
  await page.locator('.settings-dialog .settings-open-json').click();
  await waitFor(async () => (await page.locator('.settings-dialog').count()) === 0, 5000, 'the settings panel to step aside');
  await waitFor(async () => (await page.locator('#content-pane .content-tab.active .tab-label').innerText()) === 'settings.json', 10_000, 'the settings.json tab');
  // The JSON language service runs in its worker; its warning shows as a squiggle.
  await waitFor(
    async () => (await page.locator('#content-pane .content-editor:not([hidden]) :is(.squiggly-warning, .squiggly-error)').count()) > 0,
    15_000,
    'the schema warning on "wide"',
  );
  await page.screenshot({ path: path.join(runDir, 'settings-json.png') });
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
  const diffSize = await waitFor(async () => {
    const lines = page.locator('#content-pane .content-editor:not([hidden]) .monaco-diff-editor .view-lines');
    const size = (await lines.count()) ? await lines.first().evaluate((element) => getComputedStyle(element).fontSize) : '';
    return size === '18px' ? size : undefined;
  }, 10_000, 'the diff at 18px');
  // Back on the file: the editor keeps the editor font size.
  await press('Control+W');
  await waitFor(async () => (await contentTabs().count()) === 1, 5000, 'the diff tab to close');
  const editorSize = await page.locator('#content-pane .content-editor:not([hidden]) .view-lines').evaluate((element) => getComputedStyle(element).fontSize);
  if (editorSize === '18px') throw new Error('the editor took the diff font size');
  await page.locator('#content-pane .monaco-editor .view-lines').click();
  // Typing and Enter are separate undo steps.
  await waitFor(async () => {
    await page.keyboard.press('Control+Z');
    return (await page.locator('#content-pane .content-tab.dirty').count()) === 0;
  }, 5000, 'the file clean again');
  await press('Control+W');
  await waitFor(async () => (await contentTabs().count()) === 0, 5000, 'the tab to close');
  const { 'diffEditor.fontSize': _removed, ...rest } = readSettings();
  writeFileSync(settingsFile, JSON.stringify(rest, null, 2), 'utf8');
  return `diff ${diffSize}, editor ${editorSize}`;
});

await step('fonts: the UI, the conversation and its code each have their own; the bundled Noto Sans SC loads in webviews; chat.fontSize applies at once', async () => {
  const chat = await waitFor(async () => {
    for (const frame of webviewFrames()) {
      if ((await frame.locator('[role="textbox"][aria-label="Message input"]').count().catch(() => 0)) > 0) return frame;
    }
    return undefined;
  }, 10_000, 'a conversation page');
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
});

await step('settings.json reaches every Monaco option; Default Settings (JSON) lists them all', async () => {
  // Not in the settings editor, only in settings.json.
  writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), 'editor.rulers': [12] }, null, 2), 'utf8');
  await press('Control+P');
  await page.locator('.quick-input-filter').fill('sample.ts');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'sample.ts in the list');
  await page.locator('.quick-input-filter').press('Enter');
  await waitFor(async () => (await page.locator('#content-pane .content-editor:not([hidden]) .view-ruler').count()) === 1, 10_000, 'the ruler');

  await press('Control+,');
  await page.locator('.settings-dialog .settings-open-defaults').click();
  await waitFor(async () => (await page.locator('#content-pane .content-tab.active .tab-label').innerText()) === 'Default Settings', 10_000, 'the Default Settings tab');
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
  await waitFor(async () => (await auxLines.count()) > 0 && (await auxLines.innerText()).includes('"editor.rulers"'), 10_000, 'the defaults in the new window, scrolled');
  const closed = aux.waitForEvent('close');
  await aux.locator('.icon-move-back').click();
  await closed;
  await waitFor(async () => (await page.locator('#content-pane .content-tab.active .tab-label').innerText()) === 'Default Settings', 5000, 'the tab back in the pane');

  const { 'editor.rulers': _removed, ...rest } = readSettings();
  writeFileSync(settingsFile, JSON.stringify(rest, null, 2), 'utf8');
  for (let i = 0; i < 3 && (await contentTabs().count()) > 0; i++) {
    await page.locator('#content-pane .content-tab.active .tab-close').click();
    await page.waitForTimeout(200);
  }
  if ((await contentTabs().count()) > 0) throw new Error('tabs left open');
  return 'ruler shown; editor.rulers found in the defaults; moved to a window and back';
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
  if (button !== 'second') throw new Error(`the search box says ${button}`);
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
    const child = spawn(electronPath, ['.', '--user-data-dir', dataDir, '--secondary-display', ...extra], {
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
  await waitFor(async () => (await input.innerText().catch(() => '')).includes('hello from the command line'), 20_000, 'the prompt in its input');

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

// ---- M4: API providers ------------------------------------------------------------------------

/** A stand-in for an Anthropic-compatible API on 127.0.0.1: records requests, answers briefly. */
function startMockApi() {
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
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: body?.model ?? 'mock',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        if (body?.stream) {
          const events = [
            ['message_start', { type: 'message_start', message }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MOCK-OK' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
            ['message_stop', { type: 'message_stop' }],
          ];
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'MOCK-OK' }], stop_reason: 'end_turn' }));
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

await step('an API provider: the title bar switches to it, the window takes its accent, and new Claude processes send its key and model', async () => {
  const mock = await startMockApi();
  const accent = (target) =>
    target.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return { line: style.getPropertyValue('--vilaus-accent').trim(), focus: style.getPropertyValue('--vscode-focusBorder').trim() };
    });
  // The subscription: Claude's orange.
  const claude = await accent(page);
  if (claude.line !== '#d97757' || claude.focus !== '#d97757') throw new Error(`subscription accent: ${JSON.stringify(claude)}`);
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
    await waitFor(async () => (await page.locator('.titlebar-provider-label').innerText()) === 'Mock API', 5000, 'the provider in the title bar');
    await waitFor(async () => (await accent(page)).line === '#ff0000', 5000, "the provider's accent line");
    if ((await accent(page)).focus !== '#ff0000') throw new Error(`focus border: ${(await accent(page)).focus}`);
    // The window's webviews take it too.
    await waitFor(async () => {
      for (const frame of webviewFrames()) {
        if ((await accent(frame).catch(() => undefined))?.focus === '#ff0000') return true;
      }
      return false;
    }, 5000, "the provider's accent in a webview");
    // The open conversation keeps its Claude process until the window reloads, as the notice offers.
    const reload = page.locator('.toast .button', { hasText: 'Reload Window' });
    await reload.waitFor({ timeout: 5000 });
    await reloaded(() => reload.click());

    // A new conversation (the first one holds comments that later steps expect).
    const before = await tabCount();
    await press('Control+N');
    await waitFor(async () => (await tabCount()) === before + 1, 20_000, 'a new conversation');
    const frame = await waitFor(conversationFrame, 10_000, 'the new conversation');
    const input = frame.locator('[role="textbox"][aria-label="Message input"]');
    await input.waitFor({ timeout: 30_000 });
    await input.click();
    await input.fill('hello mock');
    await frame.locator('button[aria-label="Send message"]').click();
    const request = await waitFor(
      () => mock.requests.find((candidate) => candidate.body?.model === 'mock-model'),
      60_000,
      'a request for the main model at the mock API',
    );
    if (request.headers.authorization !== 'Bearer test-key-123') throw new Error(`authorization: ${request.headers.authorization}`);
    if (request.headers['x-api-key']) throw new Error('an x-api-key went out too');
    await press('Control+W');
    await waitFor(async () => (await tabCount()) === before, 10_000, 'the conversation to close');
    return `${mock.requests.length} requests at the mock; ${request.method} ${request.url}`;
  } finally {
    mock.server.close();
    // Back to the subscription, with fresh processes, for the rest of the run.
    await page.evaluate(() => window.vilausNative.invoke('providers.select', { id: 'subscription' })).catch(() => {});
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

  const name = editor.locator('.providers-row').first().locator('.setting-input');
  await name.fill('DeepSeek Work');
  await editor.locator('.providers-save').click();
  const saved = () => JSON.parse(readFileSync(path.join(dataDir, 'providers.json'), 'utf8'));
  await waitFor(() => saved().providers.some((provider) => provider.name === 'DeepSeek Work'), 5000, 'the name in providers.json');
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

await page.screenshot({ path: path.join(runDir, 'final.png') });

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
  await waitFor(async () => {
    for (const frame of webviewFrames()) {
      if ((await commentBlocks(frame).count().catch(() => 0)) === 4) return true;
    }
    return false;
  }, 30_000, 'the four comments to come back');
  return `${await tabCount()} tabs restored, with the comments`;
});

await step('when the page has no place for them, comments show in a bar below the conversation', async () => {
  await page.locator('#tabs .tab').first().click();
  const frame = await waitFor(async () => {
    const candidate = await conversationFrame();
    return candidate && (await commentBlocks(candidate).count()) === 4 ? candidate : undefined;
  }, 10_000, 'the conversation with comments');
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
  const command = await waitFor(async () => {
    const rows = page.locator('.quick-input-item');
    return (await rows.count()) ? rows.first().innerText() : undefined;
  }, 5000, 'the Chinese command');
  await page.locator('.quick-input-filter').press('Escape');

  const menu = await withRecordedMenus(async () => {
    return openContextMenu(activeConversation());
  });
  const expected = ['将会话标签页添加到分组', '将会话标记为未读', '重命名会话标签页'];
  if (!expected.every((label) => menu.includes(label))) throw new Error(`menu was: ${menu.join(' | ')}`);
  return `palette: ${command.replace(/\s+/g, ' ')}; menu: ${menu.join(' | ')}`;
});

await step("in Chinese the extension's UI is Chinese too; its content and aria-labels are not, and the setting applies at once", async () => {
  const cjk = /[一-鿿]/;
  const frame = await waitFor(conversationFrame, 10_000, 'the conversation');
  // Found by its aria-label, which stays English.
  const input = frame.locator('[role="textbox"][aria-label="Message input"]');
  await input.waitFor({ timeout: 30_000 });
  const placeholder = await waitFor(async () => {
    const value = await input.getAttribute('data-placeholder');
    return value && cjk.test(value) ? value : undefined;
  }, 10_000, 'a Chinese input placeholder');
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
    return waitFor(async () => {
      if (await page.locator('.quick-input-filter').count()) return 'input box';
      const toast = page.locator('.toast-message');
      return (await toast.count()) ? `message "${await toast.first().innerText()}"` : undefined;
    }, 10_000, 'the rename command to answer');
  });
  let rename = outcome;
  if (outcome === 'input box') {
    await page.locator('.quick-input-filter').fill('');
    await page.locator('.quick-input-filter').press('Enter');
    rename = await waitFor(async () => {
      const validation = page.locator('.quick-input-validation');
      return (await validation.count()) ? validation.innerText() : undefined;
    }, 5000, 'the validation message');
    await page.locator('.quick-input-filter').press('Escape');
  } else {
    await page.locator('.toast-close').first().click();
  }
  if (!cjk.test(rename)) throw new Error(`the rename answered in English: ${rename}`);
  return `placeholder "${placeholder}"; rename: ${rename}`;
});

await step('started without a folder, the windows open at quit come back', async () => {
  const opened = app.waitForEvent('window');
  await openFolder(page, second, true);
  const newPage = await opened;
  await waitFor(async () => showsFolder(await newPage.title(), second), 30_000, 'the second window');
  await app.close();
  app = await electron.launch({
    executablePath: electronPath,
    args: ['.', '--user-data-dir', dataDir, '--secondary-display'],
    cwd: root,
    env,
    timeout: 60_000,
  });
  page = await app.firstWindow();
  const titles = await waitFor(async () => {
    const shown = await Promise.all(shellPages().map((candidate) => candidate.title()));
    const both = [second, workspace].every((folder) => shown.some((title) => showsFolder(title, folder)));
    return shown.length === 2 && both ? shown : undefined;
  }, 30_000, 'the two windows');
  return titles.join(', ');
});

/** A .vsix like Open VSX's (`extension/` and `extension.vsixmanifest` in a zip); resolves to its path. */
function makeVsix(version, publisher = 'Anthropic') {
  const dir = path.join(runDir, `vsix-${publisher}-${version}`);
  mkdirSync(path.join(dir, 'extension'), { recursive: true });
  writeFileSync(path.join(dir, 'extension', 'package.json'), JSON.stringify({ publisher, name: 'claude-code', version, main: './extension.js' }));
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
  const main = await waitFor(async () => {
    for (const candidate of shellPages()) {
      if (showsFolder(await candidate.title(), workspace)) return candidate;
    }
    return undefined;
  }, 30_000, 'the workspace window');
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
    noGit[name] = /^path$/i.test(name) ? value.split(';').filter((dir) => !/git/i.test(dir)).join(';') : value;
  }

  const first = await electron.launch({
    executablePath: electronPath,
    args: ['.', '--user-data-dir', firstData, '--folder', firstWorkspace, '--secondary-display', '--ignore-other-editors'],
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
    await waitFor(async () => (await status.innerText()) === 'Claude Code 9.0.0 is installed.', 60_000, 'the install and the extension host');
    await waitFor(() => readJson(path.join(firstData, 'extensions', 'state.json'))?.lastGood === '9.0.0', 30_000, 'the new extension to activate');
    await firstPage.screenshot({ path: path.join(runDir, 'first-run.png') });

    await firstPage.locator('.setup-provider').click();
    await firstPage.locator('.quick-input-filter').fill('DeepSeek');
    await firstPage.locator('.quick-input-filter').press('Enter');
    await setup.waitFor({ state: 'detached', timeout: 10_000 });
    const providers = await waitFor(() => readJson(path.join(firstData, 'providers.json'))?.providers, 10_000, 'the new provider');
    const { id } = providers[0];
    // The key, as the editor saves it; the window then switches to the provider.
    await firstPage.evaluate((params) => window.vilausNative.invoke('providers.setKey', params), { id, key: 'sk-first-run' });
    await waitFor(async () => (await firstPage.locator('.titlebar-provider-label').innerText()) === 'DeepSeek', 10_000, 'the window to use DeepSeek');
    return `installed 9.0.0 from ${base}; provider ${id}`;
  } finally {
    await first.close();
    openVsx.close();
    rmSync(path.join(firstData, 'extensions'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

await step('administrator instance: runs next to the normal one, says so, and reads the API keys the normal one stored', async () => {
  const stored = readJson(path.join(dataDir, 'providers.json'))?.keys?.mock;
  if (!stored) throw new Error('the normal instance stored no key');
  const adminWorkspace = path.join(runDir, 'admin-workspace');
  mkdirSync(adminWorkspace, { recursive: true });
  const admin = await electron.launch({
    executablePath: electronPath,
    args: ['.', '--user-data-dir', dataDir, '--folder', adminWorkspace, '--secondary-display'],
    cwd: root,
    env: { ...env, VILAUS_ELEVATED: '1' },
    timeout: 60_000,
  });
  let title;
  try {
    const adminPage = await admin.firstWindow();
    await adminPage.locator('.titlebar-admin').waitFor({ timeout: 30_000 });
    // The display language is Chinese by now (an earlier step switched it).
    title = await waitFor(async () => {
      const titles = await admin.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
      return titles.find((candidate) => / \[(Administrator|管理员)\]$/.test(candidate));
    }, 10_000, 'the window title to say so');
    // safeStorage there decrypts what the normal instance encrypted: one key for both.
    const key = await admin.evaluate(({ safeStorage }, data) => safeStorage.decryptString(Buffer.from(data, 'base64')), stored);
    if (key !== 'test-key-123') throw new Error(`decrypted "${key}"`);
    // The normal instance is still there.
    await page.title();
  } finally {
    await admin.close();
  }
  for (const own of [['state', 'shell.json'], ['chromium', 'Local State']]) {
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
      executablePath: electronPath,
      args: ['.', '--user-data-dir', dataDir, '--secondary-display'],
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
  await waitFor(() => {
    const state = readExtensionState();
    return state.current === backup && state.lastGood === backup;
  }, 60_000, `Claude Code ${backup} from the backup to activate`);
  const again = await openExtensionVersion();
  const source = await again.widget.locator('.extension-version-source').innerText();
  if (!source.includes(path.join(dataDir, 'extensions'))) throw new Error(`it runs from "${source}"`);
  return `9.0.0 -> ${backup} from ${source}`;
});

await app.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Artifacts: ${runDir}`);
// The extension copies the last steps installed (a few hundred MB): never kept.
rmSync(path.join(dataDir, 'extensions'), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
if (failed === 0) {
  // The extension's processes may hold the folder a moment after the app closed.
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
process.exit(failed === 0 ? 0 : 1);
