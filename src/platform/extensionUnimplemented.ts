/**
 * Which unimplemented VS Code API members each version of the Claude Code extension used
 * (M6.6 ⑫), and when to warn: a version that uses a member the version it came from (the
 * rollback target) never did, may be missing features. Pure: the file and the window live
 * in host/main.
 */

import { compareVersions, isVersion, type ManagedExtensions } from './extensionUpdates';

/** One version's record. */
export interface UnimplementedVersionRecord {
  /** The deduped member names, e.g. `window.registerTerminalProfileProvider`. */
  readonly members: readonly string[];
  /** The user said not to warn about this version again. */
  readonly muted?: boolean;
}

/** `extensions/unimplemented.json`, by version. */
export type UnimplementedRecord = Readonly<Record<string, UnimplementedVersionRecord>>;

/** A record as it is on disk, keeping only what is well-formed. */
export function parseUnimplementedRecord(value: unknown): UnimplementedRecord {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const record: Record<string, UnimplementedVersionRecord> = {};
  for (const [version, entry] of Object.entries(source)) {
    if (!isVersion(version) || typeof entry !== 'object' || entry === null) {
      continue;
    }
    const fields = entry as Record<string, unknown>;
    const members = Array.isArray(fields.members) ? fields.members.filter((member): member is string => typeof member === 'string') : [];
    record[version] = fields.muted === true ? { members, muted: true } : { members };
  }
  return record;
}

/** Adds `member` to `version`'s record; undefined when it is already there. */
export function recordUnimplementedMember(record: UnimplementedRecord, version: string, member: string): UnimplementedRecord | undefined {
  const entry = record[version];
  if (entry?.members.includes(member)) {
    return undefined;
  }
  return {
    ...record,
    [version]: { members: [...(entry?.members ?? []), member], ...(entry?.muted ? { muted: true } : {}) },
  };
}

/** Mutes a version, keeping its members; undefined when it is already muted. */
export function muteUnimplementedVersion(record: UnimplementedRecord, version: string): UnimplementedRecord | undefined {
  if (record[version]?.muted) {
    return undefined;
  }
  return { ...record, [version]: { members: record[version]?.members ?? [], muted: true } };
}

/**
 * The version whose members `version` is compared against: `lastGood`, else `previous` — but
 * only when it is a real earlier version. After a version activates, `lastGood` is that very
 * version, so the comparison falls through to `previous`, the one kept to roll back to. After
 * a rollback the candidate is newer than the running one, so there is no baseline at all.
 */
export function unimplementedBaseline(state: ManagedExtensions, version: string): string | undefined {
  for (const candidate of [state.lastGood, state.previous]) {
    if (candidate !== undefined && candidate !== version && compareVersions(candidate, version) < 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Whether to warn that `version` uses `member`. Only when the version it came from has a
 * record (so there is a baseline) but does not include `member`. No earlier record — a fresh
 * install, or the first version to run under this feature — means no baseline, so no warning.
 * The version's own record may already list `member` (another window this run), or the user
 * may have muted it: still no warning.
 */
export function shouldWarnUnimplemented(record: UnimplementedRecord, state: ManagedExtensions, version: string, member: string): boolean {
  const entry = record[version];
  if (entry?.muted || entry?.members.includes(member)) {
    return false;
  }
  const baseline = unimplementedBaseline(state, version);
  if (baseline === undefined) {
    return false;
  }
  const baselineMembers = record[baseline]?.members;
  return baselineMembers !== undefined && !baselineMembers.includes(member);
}
