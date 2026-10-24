/**
 * The latest release on GitHub, for the About section. The request is kept short (GitHub is
 * often unreachable from where the app is used) and a successful answer is reused for an
 * hour; a failed one is not remembered, so Retry asks again. No Electron: `fetch` is
 * Electron's net.fetch in the app (it uses the system proxy), a plain fake in tests.
 */

import { latestPublishedRelease, type LatestRelease } from '../../platform/about';
import type { ILogger } from '../../platform/log';
import type { LatestReleaseResult } from '../../platform/protocol';

export type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export interface ReleaseCheckerOptions {
  readonly fetch: Fetch;
  readonly url: string;
  readonly logger: ILogger;
  /** For tests. */
  readonly now?: () => number;
}

/** A successful answer is reused for this long. */
export const RELEASE_CACHE_MS = 60 * 60_000;
/** Short on purpose: the request is made while the About section is opening. */
export const RELEASE_TIMEOUT_MS = 4_000;

export class ReleaseChecker {
  private cached: { readonly release: LatestRelease; readonly at: number } | undefined;
  /** The request in progress: opening the section twice asks GitHub once. */
  private running: Promise<LatestReleaseResult> | undefined;

  constructor(private readonly options: ReleaseCheckerOptions) {}

  /** The latest release, from the cache while it is fresh; `force` asks again (Retry). */
  async latest(force = false): Promise<LatestReleaseResult> {
    if (!force && this.cached !== undefined && this.now() - this.cached.at < RELEASE_CACHE_MS) {
      return { ok: true, release: this.cached.release };
    }
    this.running ??= this.check().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async check(): Promise<LatestReleaseResult> {
    try {
      const response = await this.options.fetch(this.options.url, {
        signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Vilausity' },
      });
      if (!response.ok) {
        this.options.logger.warn(`latest release: GitHub answered ${response.status}`);
        return { ok: false };
      }
      const release = latestPublishedRelease(await response.json());
      if (release === undefined) {
        this.options.logger.warn('latest release: no published release in the answer');
        return { ok: false };
      }
      this.cached = { release, at: this.now() };
      return { ok: true, release };
    } catch (error) {
      this.options.logger.warn(`latest release: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false };
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
