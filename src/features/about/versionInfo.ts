/** The text Copy Version Information puts on the clipboard. */

export interface VersionInfo {
  readonly app: string;
  /** Undefined when no Claude Code extension was found. */
  readonly extension: string | undefined;
  readonly electron: string;
  readonly chromium: string;
  readonly node: string;
}

export interface VersionInfoLabels {
  readonly app: string;
  readonly extension: string;
  readonly electron: string;
  readonly chromium: string;
  readonly node: string;
  readonly notInstalled: string;
}

/** One `label value` line each, in the order the About section lists them. */
export function versionInfoText(info: VersionInfo, labels: VersionInfoLabels): string {
  return [
    `${labels.app} ${info.app}`,
    `${labels.extension} ${info.extension ?? labels.notInstalled}`,
    `${labels.electron} ${info.electron}`,
    `${labels.chromium} ${info.chromium}`,
    `${labels.node} ${info.node}`,
  ].join('\n');
}
