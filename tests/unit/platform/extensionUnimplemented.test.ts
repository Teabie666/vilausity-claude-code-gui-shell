import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  muteUnimplementedVersion,
  parseUnimplementedRecord,
  recordUnimplementedMember,
  shouldWarnUnimplemented,
  unimplementedBaseline,
} from '../../../src/platform/extensionUnimplemented';
import type { ManagedExtensions } from '../../../src/platform/extensionUpdates';

describe('unimplemented API warnings', () => {
  test('a version that follows another warns about a member the old one never used', () => {
    const state: ManagedExtensions = { current: '2.1.1', previous: '2.1.0', lastGood: '2.1.0' };
    const record = { '2.1.0': { members: ['window.showInformationMessage'] } };
    assert.equal(shouldWarnUnimplemented(record, state, '2.1.1', 'window.registerTerminalProfileProvider'), true);
  });

  test('a member the previous version already used does not warn', () => {
    const state: ManagedExtensions = { current: '2.1.1', previous: '2.1.0', lastGood: '2.1.0' };
    const record = { '2.1.0': { members: ['window.registerTerminalProfileProvider'] } };
    assert.equal(shouldWarnUnimplemented(record, state, '2.1.1', 'window.registerTerminalProfileProvider'), false);
  });

  test('with no earlier record (a fresh install) there is nothing to compare, so no warn', () => {
    const state: ManagedExtensions = { current: '2.1.1' };
    assert.equal(shouldWarnUnimplemented({}, state, '2.1.1', 'window.registerTerminalProfileProvider'), false);
    // An earlier version exists but has no record either.
    const withPrevious: ManagedExtensions = { current: '2.1.1', previous: '2.1.0', lastGood: '2.1.0' };
    assert.equal(shouldWarnUnimplemented({}, withPrevious, '2.1.1', 'window.registerTerminalProfileProvider'), false);
  });

  test('a version that used nothing (an empty record) still counts as a baseline', () => {
    const state: ManagedExtensions = { current: '2.1.1', previous: '2.1.0', lastGood: '2.1.0' };
    const record = { '2.1.0': { members: [] } };
    assert.equal(shouldWarnUnimplemented(record, state, '2.1.1', 'window.registerTerminalProfileProvider'), true);
  });

  test('after "do not ask again" the version stays quiet', () => {
    const state: ManagedExtensions = { current: '2.1.1', previous: '2.1.0', lastGood: '2.1.0' };
    const record = {
      '2.1.0': { members: ['window.showInformationMessage'] },
      '2.1.1': { members: [], muted: true },
    };
    assert.equal(shouldWarnUnimplemented(record, state, '2.1.1', 'window.registerTerminalProfileProvider'), false);
  });

  test('a member already recorded for the running version (another window this run) does not warn', () => {
    const state: ManagedExtensions = { current: '2.1.1', previous: '2.1.0', lastGood: '2.1.0' };
    const record = {
      '2.1.0': { members: ['window.showInformationMessage'] },
      '2.1.1': { members: ['window.registerTerminalProfileProvider'] },
    };
    assert.equal(shouldWarnUnimplemented(record, state, '2.1.1', 'window.registerTerminalProfileProvider'), false);
  });

  test('the baseline is lastGood, else previous, and only an earlier version', () => {
    // After activation lastGood is the running version, so the comparison falls through to previous.
    const state: ManagedExtensions = { current: '2.1.1', previous: '2.1.0', lastGood: '2.1.1' };
    assert.equal(unimplementedBaseline(state, '2.1.1'), '2.1.0');
    // During activation (before markGood) lastGood is still the version before.
    const activating: ManagedExtensions = { current: '2.1.1', previous: '2.1.0', lastGood: '2.1.0' };
    assert.equal(unimplementedBaseline(activating, '2.1.1'), '2.1.0');
    // After a rollback the only candidate is newer than the running one: no baseline.
    const rolledBack: ManagedExtensions = { current: '2.1.0', previous: '2.1.1', lastGood: '2.1.1' };
    assert.equal(unimplementedBaseline(rolledBack, '2.1.0'), undefined);
  });

  test('recording is idempotent and muting keeps the members', () => {
    const recorded = recordUnimplementedMember({}, '2.1.1', 'window.registerTerminalProfileProvider');
    assert.deepEqual(recorded, { '2.1.1': { members: ['window.registerTerminalProfileProvider'] } });
    assert.equal(recordUnimplementedMember(recorded ?? {}, '2.1.1', 'window.registerTerminalProfileProvider'), undefined);
    const muted = muteUnimplementedVersion(recorded ?? {}, '2.1.1');
    assert.deepEqual(muted, { '2.1.1': { members: ['window.registerTerminalProfileProvider'], muted: true } });
    assert.equal(muteUnimplementedVersion(muted ?? {}, '2.1.1'), undefined);
  });

  test('a record on disk is kept only where it is well-formed', () => {
    assert.deepEqual(
      parseUnimplementedRecord({ '2.1.0': { members: ['a.b', 3, null], muted: false }, 'not-a-version': { members: ['x'] } }),
      { '2.1.0': { members: ['a.b'] } },
    );
  });
});
