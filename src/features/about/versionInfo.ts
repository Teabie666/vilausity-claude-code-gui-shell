/**
 * The text Copy Version Information puts on the clipboard: English whatever the display
 * language, since it ends up in bug reports.
 */

export interface VersionInfo {
  readonly app: string;
  /** Undefined when no Claude Code extension was found. */
  readonly extension: string | undefined;
  readonly electron: string;
  readonly chromium: string;
  readonly node: string;
  readonly os: string;
}

/** One `Name: value` line each, as VS Code's About copies them. */
export function versionInfoText(info: VersionInfo): string {
  return [
    `Vilausity: ${info.app}`,
    `Claude Code extension: ${info.extension ?? 'not found'}`,
    `Electron: ${info.electron}`,
    `Chromium: ${info.chromium}`,
    `Node.js: ${info.node}`,
    `OS: ${info.os}`,
  ].join('\n');
}
