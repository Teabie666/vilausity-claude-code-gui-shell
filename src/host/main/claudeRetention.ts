/**
 * How long Claude Code keeps its sessions. Each time Claude Code starts (from Vilausity, the
 * CLI or VS Code), it deletes the transcripts of the sessions inactive for longer than
 * `cleanupPeriodDays` in its settings (30 days when not set; it takes no 0 for "never": checked
 * with 2.1.296). `vilaus.sessions.deleteAfterDays` (0, the default: never) is written there, in
 * Claude Code's own user settings, `<Claude Code folder>/settings.json`: never as 36500 days.
 *
 * A value set there some other way (by hand, say) is left alone, and said so in the settings.
 * Ours is the one Vilausity wrote last, remembered in a file both instances share; before there
 * was one, Vilausity only ever wrote 36500 (the `keepForever` switch that came before). Edits go
 * through jsonc-parser, so the rest of the file stays as it was.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { writeFileAtomic } from '../node/jsonFile';

export const CLEANUP_PERIOD_KEY = 'cleanupPeriodDays';
/** A hundred years: as good as forever, and still a date Claude Code can count back to. */
export const KEEP_FOREVER_DAYS = 36500;

/** What Claude Code's settings say: the period, and whether it was set outside Vilausity. */
export interface RetentionState {
  readonly days: number | undefined;
  readonly ownValue: boolean;
}

/**
 * Claude Code's settings.json as it is to be (`text`: as it is, undefined when there is none),
 * with the period `days` wants (0: never), unless it holds a period of someone else's;
 * `edited` is undefined when it stays as it is, or is not a JSON object (Claude Code says so
 * itself, and does not clean up then). `written`: the period Vilausity wrote last.
 */
export function retentionEdit(
  text: string | undefined,
  days: number,
  written: number | undefined,
): { edited: string | undefined; state: RetentionState } {
  const source = text?.trim() ? text : '{}\n';
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { edited: undefined, state: { days: undefined, ownValue: false } };
  }
  const wanted = days > 0 ? days : KEEP_FOREVER_DAYS;
  const current = (value as Record<string, unknown>)[CLEANUP_PERIOD_KEY];
  const ours = current === undefined || current === wanted || current === (written ?? KEEP_FOREVER_DAYS);
  if (!ours) {
    return { edited: undefined, state: { days: typeof current === 'number' ? current : undefined, ownValue: true } };
  }
  if (current === wanted) {
    return { edited: undefined, state: { days: wanted, ownValue: false } };
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const edits = modify(source, [CLEANUP_PERIOD_KEY], wanted, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } });
  return { edited: applyEdits(source, edits), state: { days: wanted, ownValue: false } };
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return undefined;
  }
}

/**
 * Brings Claude Code's settings.json in line with `days` (0: never); `writtenFile` remembers
 * the period written. Says what it found, and the period it wrote, if it wrote one.
 */
export async function applyRetention(
  configDir: string,
  days: number,
  writtenFile: string,
): Promise<RetentionState & { readonly wrote?: number }> {
  let written: number | undefined;
  try {
    const parsed: unknown = JSON.parse((await readText(writtenFile)) ?? 'null');
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as { written?: unknown }).written : undefined;
    written = typeof value === 'number' ? value : undefined;
  } catch {
    // Unreadable: as if none was written.
  }
  const { edited, state } = retentionEdit(await readText(path.join(configDir, 'settings.json')), days, written);
  if (!state.ownValue && state.days !== undefined && state.days !== written) {
    await fs.promises.mkdir(path.dirname(writtenFile), { recursive: true });
    await writeFileAtomic(writtenFile, `${JSON.stringify({ written: state.days })}\n`);
  }
  if (edited === undefined) {
    return state;
  }
  await writeFileAtomic(path.join(configDir, 'settings.json'), edited);
  return { ...state, wrote: state.days };
}
