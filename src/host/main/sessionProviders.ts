/**
 * Which API provider each Claude Code session ran under: `session-providers.jsonl` in the data
 * folder, one line per Claude process that made a call, `{s: session id, p: provider id,
 * n: its name then, t: when the process started (epoch ms)}`. Appended to only, by main (both
 * instances, normal and administrator, share the file, as they share the providers); read by
 * the usage index in the sessions worker. A broken line is just one tag less.
 */

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionTag } from '../../platform/usage';

/** Tags by session id, oldest first. */
export type SessionTags = ReadonlyMap<string, readonly SessionTag[]>;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tagLine(sessionId: string, tag: SessionTag): string {
  return `${JSON.stringify({ s: sessionId, p: tag.provider, n: tag.name, t: tag.at })}\n`;
}

export function parseTags(text: string): Map<string, SessionTag[]> {
  const tags = new Map<string, SessionTag[]>();
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const { s, p, n, t } = entry as Record<string, unknown>;
    if (typeof s !== 'string' || !SESSION_ID.test(s) || typeof p !== 'string' || !p || typeof t !== 'number' || !Number.isFinite(t)) {
      continue;
    }
    const list = tags.get(s) ?? [];
    list.push({ provider: p, name: typeof n === 'string' ? n : '', at: t });
    tags.set(s, list);
  }
  for (const list of tags.values()) {
    list.sort((a, b) => a.at - b.at);
  }
  return tags;
}

/** Main's side: adds tags. */
export class SessionTagWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  add(sessionId: string, tag: SessionTag): Promise<void> {
    const write = this.queue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, tagLine(sessionId, tag), 'utf8');
    });
    // A failed write must not fail the ones queued after it.
    this.queue = write.catch(() => undefined);
    return write;
  }
}

/** The worker's side: the tags, read again when the file changed. */
export class SessionTagReader {
  private known: { mtimeMs: number; size: number; tags: SessionTags } | undefined;

  constructor(private readonly filePath: string) {}

  async read(): Promise<SessionTags> {
    const stats = await stat(this.filePath).catch(() => undefined);
    if (!stats) {
      return new Map();
    }
    if (this.known?.mtimeMs === stats.mtimeMs && this.known.size === stats.size) {
      return this.known.tags;
    }
    const text = await readFile(this.filePath, 'utf8').catch(() => '');
    const tags = parseTags(text);
    this.known = { mtimeMs: stats.mtimeMs, size: stats.size, tags };
    return tags;
  }
}
