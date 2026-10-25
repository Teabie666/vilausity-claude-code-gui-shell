import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ONBOARDING_VERSION, onboardingDue } from '../../../src/platform/onboarding';

/** The normal instance, with nothing in the environment. */
const normal = { elevated: false, env: {} };

describe('onboardingDue', () => {
  test('a fresh install shows it', () => {
    assert.equal(onboardingDue(undefined, normal), true);
  });

  test('a value that is not a version counts as not seen', () => {
    assert.equal(onboardingDue('1.0!', normal), true);
    assert.equal(onboardingDue(17, normal), true);
    assert.equal(onboardingDue({ version: '1.0.0' }, normal), true);
  });

  test('an older version was done before this one: it shows', () => {
    assert.equal(onboardingDue('0.9.4', normal), true);
  });

  test('finished or skipped at this version, or a later one: it does not show', () => {
    assert.equal(onboardingDue(ONBOARDING_VERSION, normal), false);
    assert.equal(onboardingDue('1.2.0', normal), false);
  });

  test('the administrator instance does not show it', () => {
    assert.equal(onboardingDue(undefined, { elevated: true, env: {} }), false);
  });

  test('VILAUS_ONBOARDING=0 turns it off (tests); any other value leaves it as usual', () => {
    assert.equal(onboardingDue(undefined, { elevated: false, env: { VILAUS_ONBOARDING: '0' } }), false);
    assert.equal(onboardingDue(undefined, { elevated: false, env: { VILAUS_ONBOARDING: '1' } }), true);
  });
});
