/**
 * Updating the Claude Code extension from Open VSX: version order, the state of the copies
 * vilaus installs itself (current, previous, pending), what to install, and the checks a
 * package must pass. Pure: the files and the network are in host/main.
 */

export const EXTENSION_PUBLISHER = 'anthropic';
export const EXTENSION_NAME = 'claude-code';
export const DEFAULT_OPEN_VSX_URL = 'https://open-vsx.org';

export const AUTO_UPDATE_SETTING = 'vilaus.extension.autoUpdate';
/** A version to stay on (installed from Open VSX if needed); empty follows the latest. */
export const PINNED_VERSION_SETTING = 'vilaus.extension.version';
/** Open VSX or a mirror of it. */
export const OPEN_VSX_URL_SETTING = 'vilaus.extension.openVsxUrl';

/** The copies vilaus manages, by version. All optional: there may be none yet. */
export interface ManagedExtensions {
  /** The one the windows load. */
  readonly current?: string;
  /** The one before it, kept to roll back to. */
  readonly previous?: string;
  /** Installed; becomes current at the next start. */
  readonly pending?: string;
  /** The last version that activated. */
  readonly lastGood?: string;
  /** Rolled back from: automatic updates leave this version alone. */
  readonly skipped?: string;
}

export type ExtensionErrorCode =
  | 'network'
  | 'notFound'
  | 'checksum'
  | 'notClaudeCode'
  | 'wrongPlatform'
  | 'badPackage'
  | 'extract'
  /** Another check or install is running. */
  | 'busy'
  /** Going back: there is no version before the one in use. */
  | 'noPrevious';

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** Versions become directory names: digits, dots, dashes and letters only. */
export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(\.\d+)*(-[0-9A-Za-z.]+)?$/.test(value) && value.length <= 64;
}

export function parseManagedExtensions(value: unknown): ManagedExtensions {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const pick = (key: keyof ManagedExtensions): { [key: string]: string } => (isVersion(record[key]) ? { [key]: record[key] } : {});
  return {
    ...pick('current'),
    ...pick('previous'),
    ...pick('pending'),
    ...pick('lastGood'),
    ...pick('skipped'),
  };
}

/** At startup: the pending version becomes current, and the current one is kept as previous. */
export function switchToPending(state: ManagedExtensions, isInstalled: (version: string) => boolean): ManagedExtensions {
  const { pending, ...rest } = state;
  if (pending === undefined || pending === state.current || !isInstalled(pending)) {
    return rest;
  }
  const previous = state.current ?? state.previous;
  return { ...rest, current: pending, ...(previous !== undefined && previous !== pending ? { previous } : {}) };
}

/**
 * Back to `version` (the previous one, or another editor's copy taken into the store) at
 * the next start. The current one is then skipped by automatic updates, until a newer one
 * comes out.
 */
export function rollBackTo(state: ManagedExtensions, version: string): ManagedExtensions {
  return { ...state, pending: version, ...(state.current !== undefined ? { skipped: state.current } : {}) };
}

/** The versions whose directories are kept; the rest are removed at startup. */
export function keptVersions(state: ManagedExtensions): string[] {
  return [state.current, state.previous, state.pending].filter((version): version is string => version !== undefined);
}

export interface InstallQuery {
  readonly state: ManagedExtensions;
  /** The version the windows run now, managed or not (a VSCodium copy, say). */
  readonly running: string | undefined;
  /** What Open VSX offers: the latest, or the pinned version. */
  readonly available: string;
  readonly pinned: boolean;
  /** The user asked: a skipped version is installed anyway. */
  readonly manual: boolean;
}

export function shouldInstall({ state, running, available, pinned, manual }: InstallQuery): boolean {
  const newest = state.pending ?? state.current ?? running;
  if (pinned) {
    // Pinning may go back as well as forward.
    return available !== newest;
  }
  if (newest !== undefined && compareVersions(available, newest) <= 0) {
    return false;
  }
  return manual || available !== state.skipped;
}

/** One version on Open VSX, from `GET /api/<namespace>/<name>/<platform>[/<version>]`. */
export interface OpenVsxRelease {
  readonly version: string;
  readonly download: string;
  /** The `.sha256` file: 64 hex digits. */
  readonly sha256: string;
}

export function parseOpenVsxRelease(value: unknown, targetPlatform: string): OpenVsxRelease | undefined {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const files = typeof record.files === 'object' && record.files !== null ? (record.files as Record<string, unknown>) : {};
  const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b;
  if (
    !same(record.namespace, EXTENSION_PUBLISHER) ||
    !same(record.name, EXTENSION_NAME) ||
    (record.targetPlatform !== undefined && record.targetPlatform !== targetPlatform) ||
    !isVersion(record.version) ||
    typeof files.download !== 'string' ||
    typeof files.sha256 !== 'string'
  ) {
    return undefined;
  }
  return { version: record.version, download: files.download, sha256: files.sha256 };
}

export function releaseUrl(baseUrl: string, targetPlatform: string, version?: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = version ? `/${encodeURIComponent(version)}` : '';
  return `${base}/api/${EXTENSION_PUBLISHER}/${EXTENSION_NAME}/${targetPlatform}${suffix}`;
}

/** The `<Identity>` attributes of `extension.vsixmanifest`. */
export function vsixIdentity(xml: string): Readonly<Record<string, string>> {
  const tag = /<Identity\b([^>]*)>/.exec(xml)?.[1] ?? '';
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

/**
 * Whether an unpacked package is the Claude Code extension for this platform; the error
 * code if not. A package from a .vsix file has no checksum to compare, so this is all the
 * checking it gets.
 */
export function checkPackage(
  manifest: unknown,
  identity: Readonly<Record<string, string>>,
  targetPlatform: string,
): { readonly version: string } | { readonly error: ExtensionErrorCode } {
  const record = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>) : {};
  const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b;
  if (!same(record.publisher, EXTENSION_PUBLISHER) || !same(record.name, EXTENSION_NAME)) {
    return { error: 'notClaudeCode' };
  }
  if (!isVersion(record.version) || typeof record.main !== 'string') {
    return { error: 'badPackage' };
  }
  // A package without a target platform is universal; this one ships a native binary, so
  // it should name one, but an unnamed one is let through.
  const platform = identity.TargetPlatform;
  if (platform !== undefined && platform !== targetPlatform) {
    return { error: 'wrongPlatform' };
  }
  return { version: record.version };
}

/** VS Code's target platform names: `win32-x64`, `win32-arm64`, `darwin-arm64`... */
export function targetPlatformOf(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}
