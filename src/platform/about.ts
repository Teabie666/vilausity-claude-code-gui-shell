/**
 * The About section's facts that are not the running program's: where the project and its
 * releases live, how versions compare, and the latest release in GitHub's answer. Pure:
 * the request itself is in host/main.
 */

export const REPOSITORY_URL = 'https://github.com/Teabie666/vilausity-claude-code-gui-shell';
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
export const RELEASES_API_URL = 'https://api.github.com/repos/Teabie666/vilausity-claude-code-gui-shell/releases?per_page=30';

export interface LatestRelease {
  /** Without the `v` of the tag. */
  readonly version: string;
  readonly url: string;
  readonly publishedAt?: string;
}

/** A tag's version, as the app's version reads: `v0.9.5` -> `0.9.5`. */
export function releaseVersion(tag: string): string {
  return tag.trim().replace(/^[vV]/, '');
}

/**
 * Semver-like order: numeric parts compare as numbers, missing parts count as zero, build
 * metadata is ignored, and a pre-release is below the release it leads to (`1.0.0-beta.1`
 * < `1.0.0`), as semver says.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < length; index++) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    if (left.pre.length === right.pre.length) {
      return 0;
    }
    // The one with a pre-release is the earlier.
    return left.pre.length === 0 ? 1 : -1;
  }
  const preLength = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < preLength; index++) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    if (x === y) {
      continue;
    }
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      return Number(x) < Number(y) ? -1 : 1;
    }
    // Numeric identifiers sort before alphanumeric ones.
    if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether `candidate` is a later version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * The newest release by publish time among GitHub's releases: drafts are not published,
 * pre-releases count. Malformed entries are skipped; undefined when there is none.
 */
export function latestPublishedRelease(value: unknown): LatestRelease | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  let latest: { release: LatestRelease; time: number } | undefined;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.draft === true || typeof record.tag_name !== 'string') {
      continue;
    }
    const version = releaseVersion(record.tag_name);
    if (!version) {
      continue;
    }
    const publishedAt = typeof record.published_at === 'string' ? record.published_at : undefined;
    const parsed = publishedAt === undefined ? Number.NaN : Date.parse(publishedAt);
    const time = Number.isFinite(parsed) ? parsed : 0;
    const release: LatestRelease = {
      version,
      url: typeof record.html_url === 'string' ? record.html_url : RELEASES_URL,
      ...(publishedAt === undefined || !Number.isFinite(parsed) ? {} : { publishedAt }),
    };
    if (latest === undefined || time > latest.time || (time === latest.time && compareVersions(version, latest.release.version) > 0)) {
      latest = { release, time };
    }
  }
  return latest?.release;
}

function parseVersion(value: string): { core: number[]; pre: string[] } {
  // Build metadata (`+...`) does not change the order.
  const normalized = releaseVersion(value).split('+')[0] ?? '';
  const dash = normalized.indexOf('-');
  const coreText = dash >= 0 ? normalized.slice(0, dash) : normalized;
  const preText = dash >= 0 ? normalized.slice(dash + 1) : '';
  return {
    core: coreText.split('.').map((part) => {
      const match = /^\d+/.exec(part);
      return match ? Number(match[0]) : 0;
    }),
    pre: preText ? preText.split('.') : [],
  };
}
