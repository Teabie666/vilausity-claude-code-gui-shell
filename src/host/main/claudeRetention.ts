/**
 * Keeping Claude Code's sessions. Each time Claude Code starts (from Vilausity, the CLI or VS
 * Code), it deletes the transcripts of the sessions inactive for longer than `cleanupPeriodDays`
 * in its settings (30 days when not set; it takes no 0 for "never": checked with 2.1.296). With
 * `vilaus.sessions.keepForever` on (the default), main sets it in Claude Code's own user
 * settings, `<Claude Code folder>/settings.json`, when it is not set there, to 36500 days;
 * turned off, it takes that value out again. A value set some other way is left alone. Edits go
 * through jsonc-parser, so the rest of the file stays as it was.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { writeFileAtomic } from '../node/jsonFile';

export const CLEANUP_PERIOD_KEY = 'cleanupPeriodDays';
/** A hundred years: as good as forever, and still a date Claude Code can count back to. */
export const KEEP_FOREVER_DAYS = 36500;

/**
 * Claude Code's settings.json as it is to be (`text`: as it is, undefined when there is
 * none); undefined when it stays as it is, or is not a JSON object (Claude Code says so
 * itself, and does not clean up then).
 */
export function retentionEdit(text: string | undefined, keep: boolean): string | undefined {
  const source = text?.trim() ? text : '{}\n';
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const current = (value as Record<string, unknown>)[CLEANUP_PERIOD_KEY];
  if (keep ? current !== undefined : current !== KEEP_FOREVER_DAYS) {
    return undefined;
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const edits = modify(source, [CLEANUP_PERIOD_KEY], keep ? KEEP_FOREVER_DAYS : undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  return applyEdits(source, edits);
}

/** Brings Claude Code's settings.json in line with the setting; says what it changed, if anything. */
export async function applyRetention(configDir: string, keep: boolean): Promise<'set' | 'removed' | undefined> {
  const file = path.join(configDir, 'settings.json');
  let text: string | undefined;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const edited = retentionEdit(text, keep);
  if (edited === undefined) {
    return undefined;
  }
  await writeFileAtomic(file, edited);
  return keep ? 'set' : 'removed';
}
