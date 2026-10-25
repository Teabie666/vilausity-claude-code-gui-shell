/**
 * The setup guide and the quick start a new version shows: whether a start shows them, and
 * which step it shows. Pure: the state file and the windows live in host/main.
 */

import { compareVersions, isVersion } from './extensionUpdates';

/** Raised when the onboarding changes enough to be shown again to everyone. */
export const ONBOARDING_VERSION = '1.0.0';
/** In state/shell.json: the ONBOARDING_VERSION last finished or skipped. */
export const ONBOARDING_STATE_KEY = 'onboardingVersion';
/** The setup guide first; the quick start follows it. */
export type OnboardingStep = 'setup' | 'quickStart';

/**
 * Whether this start shows the onboarding: not finished at this version, not the
 * administrator instance, not turned off with VILAUS_ONBOARDING=0 (tests).
 */
export function onboardingDue(
  seen: unknown,
  options: { readonly elevated: boolean; readonly env: Readonly<Record<string, string | undefined>> },
): boolean {
  if (options.elevated || options.env.VILAUS_ONBOARDING === '0') {
    return false;
  }
  // A value that is not a version (none yet, or written by hand) counts as not seen.
  return !isVersion(seen) || compareVersions(seen, ONBOARDING_VERSION) < 0;
}
