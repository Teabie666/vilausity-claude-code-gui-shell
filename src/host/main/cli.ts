/** Command-line arguments. `vilaus --help` lists them (HELP_TEXT). */

import * as path from 'node:path';
import { parseArgs } from 'node:util';

/** A file to show, optionally at a line and column (1-based). */
export interface GotoTarget {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

export interface CliArgs {
  /** Workspace folder to open (or a file, which opens in its folder's window). */
  readonly folder?: string;
  /** A `vilaus://` link for the extension: Windows passes protocol links as an argument. */
  readonly uri?: string;
  /** Open a new window even without a folder (a folder always gets a window of its own). */
  readonly newWindow: boolean;
  /** A Claude Code session (conversation) to open. */
  readonly session?: string;
  /** A prompt for the conversation that opens. */
  readonly prompt?: string;
  /** The API provider (its id) for the window the arguments go to. */
  readonly provider?: string;
  readonly goto?: GotoTarget;
  /** Load the Claude Code extension from this directory instead of the managed copy. */
  readonly extensionDir?: string;
  /** Use a separate data directory (settings, state, logs), e.g. for tests. */
  readonly userDataDir?: string;
  readonly logLevel?: string;
  readonly theme?: string;
  readonly devtools: boolean;
  /** Open the window on a display other than the primary one, if there is one (tests do). */
  readonly secondaryDisplay: boolean;
  /** Do not use VSCodium's or VS Code's copy of the extension (tests of the first run do). */
  readonly ignoreOtherEditors: boolean;
  /** Open the folder in the administrator instance (File Explorer's "(Administrator)" entry). */
  readonly admin: boolean;
  /** Add, or remove, File Explorer's "Open with Vilausity" entries and quit (the installer does). */
  readonly registerContextMenu: boolean;
  readonly unregisterContextMenu: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export const HELP_TEXT = `Usage: vilaus [folder] [options]

  folder                          Open this folder (a file opens in its folder's window)
  --new-window                    Open a new window even when no folder is given
  --session <id>                  Open this Claude Code conversation
  --prompt <text>                 Open a new conversation with this text in its input
  --goto <file[:line[:column]]>   Open a file at a line
  --provider <id>                 Use this API provider in the window
  --extension-dir <dir>           Load the Claude Code extension from this folder
  --user-data-dir <dir>           Keep settings, state and logs here (a separate instance)
  --theme <id>                    Start with this color theme
  --log-level <level>             trace, debug, info, warn or error
  --devtools                      Open the developer tools
  --admin                         Open the folder as administrator (Windows asks first)
  --register-context-menu         Add "Open with Vilausity" to File Explorer's menu and exit
  --unregister-context-menu       Remove it again and exit
  -v, --version                   Print the version and exit
  -h, --help                      Print this help and exit

A second start hands its arguments to the running instance that uses the same data folder.
`;

/**
 * The user's arguments in `process.argv`: everything after the executable, and in
 * development (`electron [switches] <app path> [args]`) everything after the app path.
 * Switches can come before the app path (Playwright puts `--inspect=0` there).
 */
export function userArguments(argv: readonly string[], packaged: boolean): string[] {
  const rest = argv.slice(1);
  if (packaged) {
    return rest;
  }
  const appPath = rest.findIndex((arg) => !arg.startsWith('-'));
  return appPath < 0 ? [] : rest.slice(appPath + 1);
}

/** `argv`: the user's arguments only (see `userArguments`); relative paths resolve against `cwd`. */
export function parseCliArgs(argv: readonly string[], cwd = process.cwd()): CliArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    strict: false,
    allowPositionals: true,
    options: {
      folder: { type: 'string' },
      'new-window': { type: 'boolean' },
      session: { type: 'string' },
      prompt: { type: 'string' },
      goto: { type: 'string' },
      provider: { type: 'string' },
      'extension-dir': { type: 'string' },
      'user-data-dir': { type: 'string' },
      'log-level': { type: 'string' },
      theme: { type: 'string' },
      devtools: { type: 'boolean' },
      'secondary-display': { type: 'boolean' },
      'ignore-other-editors': { type: 'boolean' },
      admin: { type: 'boolean' },
      'register-context-menu': { type: 'boolean' },
      'unregister-context-menu': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
  const resolvePath = (p: string | undefined): string | undefined => (p ? path.resolve(cwd, driveRoot(p)) : undefined);
  const positional = positionals.find((p) => !p.startsWith('-'));
  const uri = positional && /^vilaus:/i.test(positional) ? positional : undefined;

  return {
    folder: resolvePath(str(values.folder) ?? (uri ? undefined : positional)),
    uri,
    newWindow: values['new-window'] === true,
    session: str(values.session),
    prompt: str(values.prompt),
    goto: parseGoto(str(values.goto), cwd),
    provider: str(values.provider),
    extensionDir: resolvePath(str(values['extension-dir'])),
    userDataDir: resolvePath(str(values['user-data-dir'])),
    logLevel: str(values['log-level']),
    theme: str(values.theme),
    devtools: values.devtools === true,
    secondaryDisplay: values['secondary-display'] === true,
    ignoreOtherEditors: values['ignore-other-editors'] === true,
    admin: values.admin === true,
    registerContextMenu: values['register-context-menu'] === true,
    unregisterContextMenu: values['unregister-context-menu'] === true,
    help: values.help === true,
    version: values.version === true,
  };
}

/**
 * `D:"` is a drive's root as File Explorer's menu passes it: in `"%V"` the backslash of `D:\`
 * escapes the closing quote, which then ends up in the argument.
 */
function driveRoot(value: string): string {
  return /^[a-z]:"$/i.test(value) ? `${value.slice(0, 2)}\\` : value;
}

/** `C:\a\b.ts:12:5` -> path, line 12, column 5 (the drive letter's colon is part of the path). */
export function parseGoto(value: string | undefined, cwd: string): GotoTarget | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(.+?)(?::(\d+))?(?::(\d+))?$/.exec(value);
  if (!match?.[1]) {
    return undefined;
  }
  const line = match[2] ? Number(match[2]) : undefined;
  const column = match[3] ? Number(match[3]) : undefined;
  return {
    path: path.resolve(cwd, match[1]),
    line: line && line > 0 ? line : undefined,
    column: column && column > 0 ? column : undefined,
  };
}
