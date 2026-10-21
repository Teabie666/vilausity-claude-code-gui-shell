/**
 * Opens a terminal in a folder, outside the shell: the program of VS Code's setting
 * `terminal.external.windowsExec` when it is set, else Windows Terminal when it is
 * installed, else PowerShell. Started from this process, so the administrator instance's
 * terminal runs as administrator too. Launched as VS Code launches its external terminal:
 * through `cmd /c start`, which gives a console program a window of its own.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanEnvironment } from '../node/environment';

export const EXTERNAL_TERMINAL_SETTING = 'terminal.external.windowsExec';

export interface TerminalLaunch {
  /** cmd.exe */
  readonly file: string;
  readonly args: readonly string[];
}

/** What to run for a terminal (the folder is the working directory it runs in). */
export function terminalLaunch(configured: unknown, windowsTerminal: string | undefined, comspec: string): TerminalLaunch {
  const program = (typeof configured === 'string' ? configured.trim() : '') || windowsTerminal || 'powershell.exe';
  const args = ['/c', 'start'];
  // `start` takes a first quoted argument for the window's title, and a path with spaces is
  // passed quoted: the title goes first then.
  if (program.includes(' ')) {
    args.push(program);
  }
  args.push(program);
  // Windows Terminal opens in its default folder unless told.
  if (/^wt(\.exe)?$/i.test(path.win32.basename(program))) {
    args.push('-d', '.');
  }
  return { file: comspec, args };
}

/** Windows Terminal's app execution alias, when it is installed for this user. */
export function findWindowsTerminal(localAppData = process.env.LOCALAPPDATA): string | undefined {
  if (!localAppData) {
    return undefined;
  }
  const alias = path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe');
  try {
    // An alias is a reparse point that stat cannot follow; it is there all the same.
    fs.lstatSync(alias);
    return alias;
  } catch {
    return undefined;
  }
}

/** Starts the terminal; rejects when it cannot be started (the folder or the program is missing). */
export function openTerminal(folder: string, launch: TerminalLaunch): Promise<void> {
  if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    return Promise.reject(new Error(`${folder} is no folder`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, [...launch.args], { cwd: folder, env: cleanEnvironment(), detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
