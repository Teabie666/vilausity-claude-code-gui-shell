/**
 * Reading a file that only grows, a line at a time (Claude Code's transcripts): what was added
 * since the last read, or all of it again when the file got shorter (rewritten).
 */

import { open, stat } from 'node:fs/promises';

const NEWLINE = 0x0a;

/** What the last read of a file saw. */
export interface AppendedState {
  readonly mtimeMs: number;
  readonly size: number;
  /** Where the last complete line read ends. */
  readonly offset: number;
}

export interface AppendedRead extends AppendedState {
  /** When the file was made (0 on a file system that keeps no creation time). */
  readonly birthtimeMs: number;
  /** The complete lines read: those after `known`'s offset, or the whole file's when `restarted`. */
  readonly text: string;
  /** Read from the start: what was known of the file no longer holds. */
  readonly restarted: boolean;
}

/**
 * The lines added to `file` since `known` was read. A last line without its newline is taken
 * when it is whole, a JSON object (a writer may leave the newline out); one still being written
 * does not parse yet and waits for next time. `'unchanged'` when the file has the size and time
 * it had then, or cannot be opened now (the known state still stands); undefined when it is gone.
 */
export async function readAppended(file: string, known: AppendedState | undefined): Promise<AppendedRead | 'unchanged' | undefined> {
  const stats = await stat(file).catch(() => undefined);
  if (!stats?.isFile()) {
    return undefined;
  }
  if (known && known.mtimeMs === stats.mtimeMs && known.size === stats.size) {
    return 'unchanged';
  }
  const restarted = !known || stats.size < known.offset;
  const offset = restarted ? 0 : known.offset;
  const length = stats.size - offset;
  const buffer = Buffer.alloc(length);
  let read = 0;
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) {
    return 'unchanged';
  }
  try {
    while (read < length) {
      const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
      if (bytesRead === 0) {
        break;
      }
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  // Up to the last newline: a byte that is never part of another character in UTF-8.
  let end = buffer.subarray(0, read).lastIndexOf(NEWLINE) + 1;
  if (end < read && isWholeLine(buffer.toString('utf8', end, read))) {
    end = read;
  }
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    birthtimeMs: stats.birthtimeMs,
    offset: offset + end,
    text: buffer.toString('utf8', 0, end),
    restarted,
  };
}

/** A line cut short never is: the object's closing brace comes last. */
function isWholeLine(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null;
  } catch {
    return false;
  }
}
