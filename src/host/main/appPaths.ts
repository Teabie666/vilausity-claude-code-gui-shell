/**
 * Where vilaus keeps its data. Everything the app writes lives under one root
 * (`%APPDATA%\Vilausity` by default) so an install in Program Files stays read-only.
 *
 * An administrator instance (elevated) runs next to the normal one, so what one process
 * owns is its own: state, logs, the Chromium profile and the extension's storage go under
 * `<root>\admin`. Settings, API providers, the installed extensions and the recently opened
 * folders are shared.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AppPaths {
  readonly root: string;
  /** This instance's own folder: `root`, or `root\admin` for the administrator instance. */
  readonly instanceRoot: string;
  readonly elevated: boolean;
  readonly settingsFile: string;
  /** The user's keybindings, next to settings.json (shared by both instances, as that is). */
  readonly keybindingsFile: string;
  readonly globalStateFile: string;
  /** What main itself remembers (windows, zoom), apart from the extension's state. */
  readonly shellStateFile: string;
  /** The other instance's (normal or administrator), only ever read: its recent folders of before they were shared. */
  readonly otherShellStateFile: string;
  /** The recently opened folders, the normal and the administrator instance's both (recentFolders.ts). */
  readonly recentFoldersFile: string;
  /** The API providers; their keys are stored encrypted. */
  readonly providersFile: string;
  /** Which provider each Claude Code session ran under (sessionProviders.ts). */
  readonly sessionProvidersFile: string;
  /** Every API call seen in the transcripts, kept after they are deleted (usageLedger.ts). */
  readonly usageLedgerFile: string;
  /** The Claude Code extension as vilaus installs it (from Open VSX or a .vsix). */
  readonly extensionsDir: string;
  /** The app icon drawn in other colors (logoIcons.ts): windows' icons and providers' shortcuts point here. */
  readonly iconsDir: string;
  /** Chromium's own profile data (cache, local storage), kept apart from ours. */
  readonly chromium: string;
  /** The other instance's Chromium profile (normal or administrator): safeStorage shares its key. */
  readonly otherChromium: string;
  readonly logsRoot: string;
  /** Logs for this run only. */
  readonly sessionLogs: string;
  /** One window's logs in this run (its extension host's): `window1`, `window2`... */
  windowLogs(windowId: number): string;
  /** `ExtensionContext.globalStorageUri` for the Claude Code extension. */
  readonly extensionGlobalStorage: string;
  workspaceStateFile(workspaceKey: string): string;
  /** `ExtensionContext.storageUri` for the Claude Code extension in one workspace. */
  extensionWorkspaceStorage(workspaceKey: string): string;
}

const EXTENSION_ID = 'anthropic.claude-code';
const KEPT_LOG_SESSIONS = 10;

const ADMIN_FOLDER = 'admin';

export function createAppPaths(root: string, startedAt = new Date(), elevated = false): AppPaths {
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const instanceRoot = elevated ? path.join(root, ADMIN_FOLDER) : root;
  const logsRoot = path.join(instanceRoot, 'logs');
  const sessionLogs = path.join(logsRoot, stamp);
  return {
    root,
    instanceRoot,
    elevated,
    settingsFile: path.join(root, 'settings.json'),
    keybindingsFile: path.join(root, 'keybindings.json'),
    globalStateFile: path.join(instanceRoot, 'state', 'global.json'),
    shellStateFile: path.join(instanceRoot, 'state', 'shell.json'),
    otherShellStateFile: path.join(elevated ? root : path.join(root, ADMIN_FOLDER), 'state', 'shell.json'),
    recentFoldersFile: path.join(root, 'state', 'recent-folders.json'),
    providersFile: path.join(root, 'providers.json'),
    sessionProvidersFile: path.join(root, 'session-providers.jsonl'),
    usageLedgerFile: path.join(root, 'usage-ledger.jsonl'),
    extensionsDir: path.join(root, 'extensions'),
    iconsDir: path.join(root, 'icons'),
    chromium: path.join(instanceRoot, 'chromium'),
    otherChromium: elevated ? path.join(root, 'chromium') : path.join(root, ADMIN_FOLDER, 'chromium'),
    logsRoot,
    sessionLogs,
    windowLogs: (windowId) => path.join(sessionLogs, `window${windowId}`),
    extensionGlobalStorage: path.join(instanceRoot, 'globalStorage', EXTENSION_ID),
    workspaceStateFile: (key) => path.join(instanceRoot, 'state', 'workspaces', `${key}.json`),
    extensionWorkspaceStorage: (key) => path.join(instanceRoot, 'workspaceStorage', key, EXTENSION_ID),
  };
}

/** Deletes all but the newest log session folders. */
export function pruneOldLogs(paths: AppPaths): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(paths.logsRoot);
  } catch {
    return;
  }
  const sessions = entries.filter((name) => /^\d{8}T\d{6}$/.test(name)).sort();
  for (const name of sessions.slice(0, Math.max(0, sessions.length - KEPT_LOG_SESSIONS))) {
    fs.rmSync(path.join(paths.logsRoot, name), { recursive: true, force: true });
  }
}
