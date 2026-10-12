// End-to-end smoke test: drives the real app with Playwright and a real Claude session.
//   npm run smoke            (build first: npm run build)
// Uses a throwaway data dir and workspace under .test-data/, and a small model to keep usage low.
// Each step prints PASS/FAIL; the process exits non-zero if any step failed.
//
// It runs against an API, configured by environment variables:
//   VILAUS_SMOKE_API_KEY     sent as ANTHROPIC_API_KEY (x-api-key), or
//   VILAUS_SMOKE_AUTH_TOKEN  sent as ANTHROPIC_AUTH_TOKEN (Bearer), e.g. for compatible APIs
//   VILAUS_SMOKE_BASE_URL    optional, ANTHROPIC_BASE_URL of an Anthropic-compatible API
//   VILAUS_SMOKE_MODEL       optional, default claude-haiku-4-5-20251001
//   VILAUS_EXECUTABLE        optional, the packaged program (release\win-unpacked\Vilausity.exe)
//                            instead of electron.exe with this checkout
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const packaged = process.env.VILAUS_EXECUTABLE ? path.resolve(process.env.VILAUS_EXECUTABLE) : undefined;
const executable = packaged ?? electronPath;
// In development electron.exe needs the app's folder first.
const appArgs = (...args) => (packaged ? args : ['.', ...args]);

// Anthropic's consumer terms allow automated (scripted) access only through an API key, so
// this test does not drive the signed-in Claude subscription unless told to explicitly.
const subscription = process.argv.includes('--subscription');
const apiKey = process.env.VILAUS_SMOKE_API_KEY;
const authToken = process.env.VILAUS_SMOKE_AUTH_TOKEN;
if (!subscription && !apiKey && !authToken) {
  console.error('smoke: not running. Set VILAUS_SMOKE_API_KEY or VILAUS_SMOKE_AUTH_TOKEN (and optionally');
  console.error('VILAUS_SMOKE_BASE_URL, VILAUS_SMOKE_MODEL): scripted use of a Claude subscription is not');
  console.error('allowed by the consumer terms. To run it against the signed-in account anyway:');
  console.error('npm run smoke -- --subscription');
  process.exit(2);
}
const model = process.env.VILAUS_SMOKE_MODEL || 'claude-haiku-4-5-20251001';

/** What the extension passes to the claude process (`claudeCode.environmentVariables`). */
function apiEnvironment() {
  const variables = { ANTHROPIC_MODEL: model };
  if (!subscription) {
    if (process.env.VILAUS_SMOKE_BASE_URL) variables.ANTHROPIC_BASE_URL = process.env.VILAUS_SMOKE_BASE_URL;
    if (apiKey) variables.ANTHROPIC_API_KEY = apiKey;
    if (authToken) variables.ANTHROPIC_AUTH_TOKEN = authToken;
    // Background requests (titles...) use the small model; keep every tier on the given one.
    variables.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    variables.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    variables.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    variables.CLAUDE_CODE_SKIP_AUTH_LOGIN = '1';
    variables.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  }
  return Object.entries(variables).map(([name, value]) => ({ name, value }));
}

const root = path.resolve(import.meta.dirname, '..');
const runDir = path.join(root, '.test-data', `smoke-${Date.now()}`);
const dataDir = path.join(runDir, 'data');
const workspace = path.join(runDir, 'workspace');
const target = path.join(workspace, 'a.txt');
const RESPONSE_TIMEOUT = 120_000;

mkdirSync(dataDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(target, 'alpha\n', 'utf8');
writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify(
    {
      // Ask before every edit, so the approval flow is exercised.
      'claudeCode.initialPermissionMode': 'default',
      'claudeCode.hideOnboarding': true,
      'claudeCode.disableLoginPrompt': !subscription,
      // English labels: the steps look for the shell's English buttons.
      'vilaus.language': 'en',
      // No download from Open VSX during the run.
      'vilaus.extension.autoUpdate': false,
      'claudeCode.environmentVariables': apiEnvironment(),
    },
    null,
    2,
  ),
  'utf8',
);

const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE' || name.toUpperCase().startsWith('VSCODE_')) delete env[name];
}
// The normal instance even when the run starts from an elevated shell (an administrator
// instance keeps its state apart and marks its windows).
env.VILAUS_ELEVATED = '0';

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - started} ms)${detail ? ` - ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}: ${error?.message ?? error}`);
  }
}

const app = await electron.launch({
  executablePath: executable,
  // On a second monitor, if there is one, out of the way of whoever started the run.
  args: appArgs('--user-data-dir', dataDir, '--folder', workspace, '--secondary-display'),
  cwd: root,
  env,
  timeout: 60_000,
});
const page = await app.firstWindow();
let frame;

async function waitFor(predicate, timeout, what) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await page.waitForTimeout(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const input = () => frame.locator('[role="textbox"][aria-label="Message input"]');
const conversation = () => frame.locator('[aria-label="Claude Code conversation"]');

async function send(text) {
  await input().click();
  await input().fill(text);
  await frame.locator('button[aria-label="Send message"]').click();
}

async function waitForIdle() {
  // The conversation is idle when the send button is back (no stop button) and input is enabled.
  await waitFor(
    async () => (await frame.locator('button[aria-label="Send message"]').count()) > 0,
    RESPONSE_TIMEOUT,
    'the turn to finish',
  );
}

async function clickPermission(label) {
  // Buttons may carry a keyboard-shortcut digit before the label ("1 Yes").
  const name = new RegExp(`^\\s*(\\d+\\s*)?${label}\\s*$`);
  const button = await waitFor(
    async () => {
      const candidate = frame.getByRole('button', { name });
      return (await candidate.count()) > 0 ? candidate.first() : undefined;
    },
    RESPONSE_TIMEOUT,
    `a permission prompt with "${label}"`,
  );
  await button.click();
}

const readTarget = () => readFileSync(target, 'utf8').trim();

await step('chat webview loads', async () => {
  // The session list is a webview too; the conversation is the iframe of the visible panel.
  const iframe = page.locator('#main .panel:not([hidden]) .webview-frame');
  frame = await waitFor(async () => {
    const candidate = (await iframe.count()) ? await (await iframe.elementHandle())?.contentFrame() : undefined;
    return candidate?.url().startsWith('ccw://wv') ? candidate : undefined;
  }, 30_000, 'the conversation frame');
  await input().waitFor({ timeout: 30_000 });
});

await step('@-mention lists workspace files (workspace.findFiles)', async () => {
  // Runs before any message, so "a.txt" can only appear in the mention suggestions.
  await input().click();
  await input().pressSequentially('@a.t', { delay: 50 });
  await waitFor(async () => (await frame.getByText('a.txt').count()) > 0, 15_000, 'a.txt in the suggestions');
  await input().press('Escape');
  await input().fill('');
});

/** What the title bar's logo shows: idle, running (Claude works) or waiting (for the user). */
const logoActivity = () => page.evaluate(() => document.querySelector('.titlebar-logo')?.dataset.activity);

await step('message round trip; the logo shows Claude at work, then rests', async () => {
  // Every state the logo goes through.
  await page.evaluate(() => {
    const element = document.querySelector('.titlebar-logo');
    window.logoStates = [element.dataset.activity];
    new MutationObserver(() => window.logoStates.push(element.dataset.activity)).observe(element, { attributeFilter: ['data-activity'] });
  });
  await send('What is 17 + 25? Reply with only the number, nothing else.');
  await waitFor(async () => /\b42\b/.test(await conversation().innerText()), RESPONSE_TIMEOUT, 'the answer 42');
  await waitForIdle();
  await waitFor(async () => (await logoActivity()) === 'idle', 10_000, 'the logo to rest');
  const states = await page.evaluate(() => window.logoStates);
  if (!states.includes('running')) throw new Error(`the logo went ${states.join(' > ')}`);
  return `logo ${states.join(' > ')}`;
});

await step('edit approved inline is applied; while Claude asks, the logo and the session list say it needs input', async () => {
  await send('Use the Edit tool to replace the word alpha with beta in a.txt. Do nothing else.');
  await waitFor(async () => (await logoActivity()) === 'waiting', RESPONSE_TIMEOUT, 'the logo to show Claude waiting for input');
  // The session list's filter button, "Needs input · 1".
  const needsInput = await waitFor(async () => {
    for (const candidate of page.frames().filter((f) => f.url().startsWith('ccw://wv'))) {
      const label = await candidate
        .evaluate(() => document.querySelector('[data-vilaus-needs-input]')?.getAttribute('data-vilaus-needs-input'))
        .catch(() => undefined);
      if (label) return label;
    }
    return undefined;
  }, 10_000, 'the session list to show "Needs input"');
  await clickPermission('Yes');
  await waitFor(() => readTarget() === 'beta', RESPONSE_TIMEOUT, 'a.txt to become "beta"');
  await waitForIdle();
  await waitFor(async () => (await logoActivity()) === 'idle', 10_000, 'the logo to rest');
  return `a.txt = ${readTarget()}; ${needsInput}`;
});

await step('edit rejected inline is not applied', async () => {
  await send('Use the Edit tool to replace the word beta with gamma in a.txt. If it is rejected, stop and do nothing else.');
  await clickPermission('No');
  await page.waitForTimeout(3000);
  await waitForIdle();
  if (readTarget() !== 'beta') throw new Error(`a.txt changed to "${readTarget()}"`);
  return 'a.txt still beta';
});

// ---- M2: proposed edits open as diff tabs in the content pane ----------------------------

const diffTab = () => page.locator('#content-pane .content-tab', { hasText: 'a.txt' });
const diffAction = (kind) => page.locator(`#content-pane .content-editor:not([hidden]) .diff-toolbar [data-action="${kind}"]`);

await step('a proposed edit opens a diff tab; Accept there applies it', async () => {
  writeFileSync(target, 'beta\n', 'utf8');
  await send('Use the Edit tool to replace the word beta with delta in a.txt. Do nothing else.');
  await waitFor(async () => (await diffAction('accept').count()) > 0, RESPONSE_TIMEOUT, 'the diff tab with Accept');
  const label = await diffTab().first().innerText();
  await diffAction('accept').click();
  await waitFor(() => readTarget() === 'delta', RESPONSE_TIMEOUT, 'a.txt to become "delta"');
  await waitFor(async () => (await diffTab().count()) === 0, 10_000, 'the diff tab to close');
  await waitForIdle();
  return `${label.trim()}; a.txt = ${readTarget()}`;
});

await step('Reject in the diff tab leaves the file as it was', async () => {
  await send('Use the Edit tool to replace the word delta with omega in a.txt. If it is rejected, stop and do nothing else.');
  await waitFor(async () => (await diffAction('reject').count()) > 0, RESPONSE_TIMEOUT, 'the diff tab with Reject');
  await diffAction('reject').click();
  await waitFor(async () => (await diffTab().count()) === 0, 10_000, 'the diff tab to close');
  await page.waitForTimeout(3000);
  await waitForIdle();
  if (readTarget() !== 'delta') throw new Error(`a.txt changed to "${readTarget()}"`);
  return 'a.txt still delta';
});

await step('a file mention in the chat opens the file in a Monaco tab', async () => {
  await send('Reply with only the word ok. @a.txt');
  // A mention in a sent message is a chip that opens the file (open_file -> showTextDocument).
  const chip = frame.locator('[role="button"][title="Open a.txt"]').first();
  await waitFor(async () => (await chip.count()) > 0, RESPONSE_TIMEOUT, 'the a.txt chip');
  await waitForIdle();
  await chip.click();
  const tab = page.locator('#content-pane .content-tab', { hasText: 'a.txt' });
  await waitFor(async () => (await tab.count()) > 0, 10_000, 'the a.txt tab');
  const text = page.locator('#content-pane .content-editor:not([hidden]) .view-lines');
  await waitFor(async () => (await text.count()) > 0 && (await text.innerText()).includes('delta'), 10_000, 'the file in Monaco');
  await tab.locator('.tab-close').click();
  await waitFor(async () => (await tab.count()) === 0, 5000, 'the tab to close');
});

await step('insert_at_mention puts plain text into the input', async () => {
  const text = 'vilaus-insert-check';
  await frame.evaluate((t) => {
    window.postMessage(
      { type: 'from-extension', message: { type: 'request', channelId: '', requestId: '', request: { type: 'insert_at_mention', text: t } } },
      '*',
    );
  }, text);
  await waitFor(async () => (await input().innerText()).includes(text), 10_000, 'the inserted text');
  await input().fill('');
});

await step('io_message shape was logged', async () => {
  const logs = path.join(dataDir, 'logs');
  const session = readdirSync(logs).sort().at(-1);
  const log = readFileSync(path.join(logs, session, 'window1', 'exthost.log'), 'utf8');
  const line = log.split('\n').find((l) => l.includes('io_message shape:'));
  if (!line) throw new Error('no io_message shape line in exthost.log');
  return line.slice(line.indexOf('io_message shape:'));
});

// ---- M3: comments go out with the next message --------------------------------------------

/** A shortcut through Electron's input pipeline, so main's intercepted chords work (see tests/ui.mjs). */
async function press(shortcut) {
  const parts = shortcut.split('+');
  const keyCode = parts.pop();
  const modifiers = parts.map((m) => m.toLowerCase());
  await app.evaluate(({ BrowserWindow }, { keyCode, modifiers }) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('ccw://app/'));
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, { keyCode, modifiers });
}

/** The user messages of this run's sessions that carry a comments block. */
function sentCommentBlocks(since) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const blocks = [];
  for (const project of existsSync(projects) ? readdirSync(projects) : []) {
    const dir = path.join(projects, project);
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
      if (statSync(path.join(dir, file)).mtimeMs < since) continue;
      for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n')) {
        if (!line.includes('Comments on selected text:')) continue;
        const content = JSON.parse(line).message?.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block.type === 'text' && block.text.startsWith('Comments on selected text:')) blocks.push(block.text);
        }
      }
    }
  }
  return blocks;
}

await step('two comments show above the input, go out with the next message, and clear', async () => {
  const started = Date.now();
  writeFileSync(path.join(workspace, 'fruit.txt'), 'first line: apples\nsecond line: bananas\n', 'utf8');
  await press('Control+P');
  await page.locator('.quick-input-filter').fill('fruit.txt');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 10_000, 'fruit.txt in quick open');
  await page.locator('.quick-input-filter').press('Enter');
  const line = (text) => page.locator('#content-pane .content-editor:not([hidden]) .view-line', { hasText: text }).first();
  await waitFor(async () => (await line('bananas').count()) > 0, 10_000, 'fruit.txt in Monaco');
  for (const [word, comment] of [['apples', 'kiwi-note'], ['bananas', 'mango-note']]) {
    await line(word).click();
    await press('Home');
    await press('Shift+End');
    await press('Control+Alt+M');
    const input = page.locator('.comment-form-input');
    await input.waitFor({ timeout: 5000 });
    await input.fill(comment);
    await input.press('Enter');
  }
  const blocks = frame.locator('.vilaus-comments .vilaus-comment');
  await waitFor(async () => (await blocks.count()) === 2, 5000, 'two blocks above the input');
  await send('Reply with only the word ok.');
  await waitFor(async () => (await blocks.count()) === 0, 10_000, 'the blocks to clear once the message is sent');
  await waitForIdle();
  const sent = await waitFor(() => sentCommentBlocks(started).at(-1), 10_000, 'the comments in the session transcript');
  const paragraphs = sent.split('\n\n').filter((paragraph) => paragraph.startsWith('[Re: "'));
  const expected = ['[Re: "first line: apples" — fruit.txt:1] kiwi-note', '[Re: "second line: bananas" — fruit.txt:2] mango-note'];
  if (paragraphs.join('|') !== expected.join('|')) throw new Error(`the message carried: ${JSON.stringify(sent)}`);
  return `${paragraphs.length} [Re: …] paragraphs sent`;
});

await step('a comment not sent yet stays with its session: the tab closes, Ctrl+Shift+T brings it back', async () => {
  const tabs = page.locator('#tabs .tab');
  const line = page.locator('#content-pane .content-editor:not([hidden]) .view-line', { hasText: 'apples' }).first();
  await line.click();
  await press('Home');
  await press('Shift+End');
  await press('Control+Alt+M');
  const form = page.locator('.comment-form-input');
  await form.waitFor({ timeout: 5000 });
  await form.fill('papaya-note');
  await form.press('Enter');
  const blocks = () => frame.locator('.vilaus-comments .vilaus-comment');
  await waitFor(async () => (await blocks().count()) === 1, 5000, 'the block above the input');
  // Ctrl+W closes the conversation only while the focus is in it, not in the editor.
  await input().click();
  const count = await tabs.count();
  await press('Control+W');
  await waitFor(async () => (await tabs.count()) === count - 1, 10_000, 'the conversation tab to close');
  await press('Control+Shift+T');
  await waitFor(async () => (await tabs.count()) === count, 20_000, 'the conversation to reopen');
  const iframe = page.locator('#main .panel:not([hidden]) .webview-frame');
  frame = await waitFor(async () => {
    const candidate = (await iframe.count()) ? await (await iframe.elementHandle())?.contentFrame() : undefined;
    return candidate && (await candidate.locator('.vilaus-comments .vilaus-comment').count()) === 1 ? candidate : undefined;
  }, 30_000, 'the comment back above the reopened conversation input');
  const text = await blocks().first().locator('.vilaus-comment-text').innerText();
  if (text !== 'papaya-note') throw new Error(`the block says ${JSON.stringify(text)}`);
  // Not for the plan below.
  await blocks().first().hover();
  await blocks().first().locator('[data-action="remove"]').click();
  await waitFor(async () => (await blocks().count()) === 0, 5000, 'the comment to go');
});

// The conversation's own Escape no longer interrupts (the shell's command, unbound by default, does).
await step('a plain Escape does not interrupt Claude; the Interrupt Claude command does', async () => {
  const sendButton = () => frame.locator('button[aria-label="Send message"]');
  await send('Count from 1 to 1000, one number per line, nothing else. Do not use any tool.');
  await waitFor(async () => (await sendButton().count()) === 0, RESPONSE_TIMEOUT, 'Claude to start');
  await input().press('Escape');
  await page.waitForTimeout(2000);
  if ((await sendButton().count()) > 0) throw new Error('Escape interrupted Claude (or the reply was over in 2 s)');
  await press('Control+Shift+P');
  const filter = page.locator('.quick-input-filter');
  await filter.waitFor({ timeout: 5000 });
  await filter.fill('>Interrupt Claude');
  await waitFor(async () => (await page.locator('.quick-input-item').count()) > 0, 5000, 'the command in the palette');
  await filter.press('Enter');
  await waitFor(async () => (await sendButton().count()) > 0, 15_000, 'the reply to stop');
  const numbers = (await conversation().innerText()).match(/^\d+$/gm) ?? [];
  return `stopped after ${numbers.length} lines`;
});

// Last: Claude may keep planning after the plan is declined.
await step('in plan mode, the plan preview opens as a content pane tab', async () => {
  await input().click();
  // Shift+Tab cycles the permission mode: manual -> edit automatically -> plan.
  await input().press('Shift+Tab');
  await input().press('Shift+Tab');
  await waitFor(async () => (await frame.getByRole('button', { name: /\bPlan\b/ }).count()) > 0, 5000, 'plan mode');
  await send('Make a plan to add a line with the word zeta to a.txt. It is a one-step plan; present it right away without exploring.');
  const preview = page.locator('#content-pane .content-editor:not([hidden]) .webview-frame');
  await waitFor(async () => (await preview.count()) > 0, RESPONSE_TIMEOUT, 'the plan preview in the content pane');
  const label = await page.locator('#content-pane .content-tab.active .tab-label').innerText();
  await clickPermission('No, keep planning');
  return `tab "${label}"`;
});

await page.screenshot({ path: path.join(runDir, 'final.png') });
await app.close();

const unimplemented = path.join(dataDir, 'logs', readdirSync(path.join(dataDir, 'logs')).sort().at(-1), 'window1', 'shim-unimplemented.log');
if (existsSync(unimplemented)) {
  const lines = readFileSync(unimplemented, 'utf8').trim();
  console.log(`\nunimplemented API used:\n${lines || '(none)'}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Artifacts: ${runDir}`);
if (failed === 0 && !process.argv.includes('--keep')) {
  // The extension's processes may hold the folder a moment after the app closed.
  rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
process.exit(failed === 0 ? 0 : 1);
