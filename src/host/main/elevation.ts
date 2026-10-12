/**
 * The administrator instance: whether this process runs elevated, and how to start an
 * elevated one. An elevated instance keeps its state and Chromium profile apart (AppPaths),
 * so it runs next to the normal one; settings, providers and extensions are shared.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Whether this process has administrator rights. `VILAUS_ELEVATED=1` or `0` says so instead:
 * tests set it, since they may be started from an elevated shell.
 */
export function isElevated(env: Environment = process.env, platform = process.platform): boolean {
  const forced = env.VILAUS_ELEVATED;
  if (forced === '1' || forced === '0') {
    return forced === '1';
  }
  if (platform !== 'win32') {
    return false;
  }
  // Only SYSTEM and Administrators may list the system profile, and a filtered (not
  // elevated) token has Administrators as deny-only.
  try {
    fs.readdirSync(path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'config', 'systemprofile'));
    return true;
  } catch {
    return false;
  }
}

/** One argument of a Windows command line, quoted the way CommandLineToArgvW reads it back. */
export function quoteWindowsArgument(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) {
    return arg;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    // Backslashes before a quote are escaped, and so is the quote; elsewhere they are literal.
    quoted += char === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/**
 * The PowerShell script that starts `executable` with `args` elevated: Windows asks the user
 * to confirm (UAC). Start-Process hands ArgumentList on as one command line.
 */
export function elevatedStartScript(executable: string, args: readonly string[]): string {
  const literal = (text: string): string => `'${text.replace(/'/g, "''")}'`;
  const commandLine = args.map(quoteWindowsArgument).join(' ');
  return `Start-Process -FilePath ${literal(executable)} -ArgumentList ${literal(commandLine)} -Verb RunAs`;
}

/**
 * The arguments of the administrator instance on `folder`: in development the app's folder
 * first (the executable is electron.exe), and the data folder when one was given.
 */
export function administratorInstanceArgs(folder: string, appPath: string | undefined, userDataDir: string | undefined): string[] {
  return [...(appPath ? [appPath] : []), folder, ...(userDataDir ? ['--user-data-dir', userDataDir] : [])];
}

/**
 * Starts `executable` with `args` elevated; Windows asks the user first (UAC). Resolves once
 * Windows took the request, or with why not (declined at the prompt, most likely).
 */
export function startElevated(executable: string, args: readonly string[]): Promise<{ started: boolean; detail?: string }> {
  const script = elevatedStartScript(executable, args);
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true },
      (error, _stdout, stderr) => resolve(error ? { started: false, detail: String(stderr).trim() || error.message } : { started: true }),
    );
  });
}
