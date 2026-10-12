/**
 * "Open with Vilausity" and "Open with Vilausity (Administrator)" in File Explorer's context
 * menu: on a folder, on a folder's background and on a drive, opening that path as the
 * workspace. Only on request (the setting, the installer's option) and only for the current
 * Windows user: the entries go under HKCU\Software\Classes, which needs no administrator rights.
 *
 * Windows 11's own menu takes only entries of signed (MSIX) apps, so there these show under
 * "Show more options", where every classic entry is. The administrator entry starts this
 * program with `--admin`, which asks Windows for an elevated instance (UAC) and quits: a
 * verb elevates by itself only if it is named `runas`, and a class has one of those.
 *
 * Written as a .reg file imported by reg.exe: one process for every key, and Unicode labels
 * survive (reg.exe prints in the console's code page, so its output is never parsed).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { quoteWindowsArgument } from './elevation';

/** The program the entries start: in development electron.exe with the app's folder first. */
export interface ExplorerMenuTarget {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
}

export interface ExplorerMenuLabels {
  readonly open: string;
  readonly openAsAdministrator: string;
}

/** Where classes go: the user's, or another key for tests (`VILAUS_REGISTRY_ROOT`, short hive names). */
export function explorerMenuRoot(env: Readonly<Record<string, string | undefined>>): string {
  return env.VILAUS_REGISTRY_ROOT || 'HKCU\\Software\\Classes';
}

/** A folder, the empty space in an open folder, a drive. */
const PARENTS = ['Directory\\shell', 'Directory\\Background\\shell', 'Drive\\shell'];
const VERB = 'Vilausity';
const ADMINISTRATOR_VERB = 'VilausityAdministrator';
const HIVES: Readonly<Record<string, string>> = {
  HKCU: 'HKEY_CURRENT_USER',
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKCR: 'HKEY_CLASSES_ROOT',
};

/** A key of `root` as a .reg file names it (full hive name). */
function regKey(root: string, ...parts: string[]): string {
  const [hive, ...rest] = root.split('\\');
  return [HIVES[hive ?? ''] ?? hive, ...rest, ...parts].join('\\');
}

/** A .reg string: backslashes and quotes escaped. */
function regString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The command a verb runs. `%V` is the folder (the drive, the folder whose background was
 * clicked); a drive's `C:\` ends in a backslash that escapes the closing quote, which the
 * command line parser undoes (cli.ts).
 */
export function explorerMenuCommand(target: ExplorerMenuTarget, administrator: boolean): string {
  const args = [...target.prefixArgs, ...(administrator ? ['--admin'] : [])].map(quoteWindowsArgument);
  return [quoteWindowsArgument(target.executable), ...args, '"%V"'].join(' ');
}

/** The .reg file that adds (or rewrites) the entries. */
export function explorerMenuRegFile(root: string, target: ExplorerMenuTarget, labels: ExplorerMenuLabels): string {
  const lines = ['Windows Registry Editor Version 5.00', ''];
  for (const parent of PARENTS) {
    for (const administrator of [false, true]) {
      const verb = administrator ? ADMINISTRATOR_VERB : VERB;
      lines.push(
        `[${regKey(root, parent, verb)}]`,
        `@=${regString(administrator ? labels.openAsAdministrator : labels.open)}`,
        `"Icon"=${regString(target.executable)}`,
        ...(administrator ? ['"HasLUAShield"=""'] : []),
        '',
        `[${regKey(root, parent, verb, 'command')}]`,
        `@=${regString(explorerMenuCommand(target, administrator))}`,
        '',
      );
    }
  }
  return lines.join('\r\n');
}

/** The .reg file that removes them. */
export function explorerMenuRemovalRegFile(root: string): string {
  const lines = ['Windows Registry Editor Version 5.00', ''];
  for (const parent of PARENTS) {
    lines.push(`[-${regKey(root, parent, VERB)}]`, `[-${regKey(root, parent, ADMINISTRATOR_VERB)}]`, '');
  }
  return lines.join('\r\n');
}

function regExe(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
}

function run(args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile(regExe(), [...args], { windowsHide: true }, (error) => {
      resolve(error ? (typeof error.code === 'number' ? error.code : 1) : 0);
    });
  });
}

/** Imports a .reg file's text (UTF-16 with a byte order mark, which keeps any language). */
async function importRegFile(text: string): Promise<void> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'vilaus-reg-'));
  const file = path.join(folder, 'explorer-menu.reg');
  try {
    await writeFile(file, Buffer.from(`\ufeff${text}`, 'utf16le'));
    const code = await run(['import', file]);
    if (code !== 0) {
      throw new Error(`reg import exited with ${code}`);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export class ExplorerMenu {
  constructor(
    private readonly root: string,
    private readonly target: ExplorerMenuTarget,
  ) {}

  /** Whether the entries are there (the folder's one stands for all). */
  async isRegistered(): Promise<boolean> {
    return (await run(['query', `${this.root}\\Directory\\shell\\${VERB}\\command`, '/ve'])) === 0;
  }

  /** Adds the entries, or rewrites them for this program's path and the display language. */
  register(labels: ExplorerMenuLabels): Promise<void> {
    return importRegFile(explorerMenuRegFile(this.root, this.target, labels));
  }

  unregister(): Promise<void> {
    return importRegFile(explorerMenuRemovalRegFile(this.root));
  }
}
