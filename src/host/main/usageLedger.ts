/**
 * Every API call the usage index has come to, kept apart from the transcripts so that what an
 * API cost stays counted after its conversations are gone: deleted from the session list, or by
 * Claude Code's own clean-up of old sessions (after 30 days by default). The session list's
 * figures follow the transcripts there are; an API's total in the providers editor follows this.
 *
 * `usage-ledger.jsonl` in the data folder: each line has one session's calls that were not in
 * it yet, or whose tokens changed, `{s: session id, f: its folder, c: [[id, at, model, input,
 * output, cacheRead, cacheWrite, thinking (1 or 0)], ...]}`. Only appended to, by the sessions
 * worker of either instance (normal and administrator share it); a call found twice (both
 * added it) is one call, its later line winning. A broken line is a few calls less, added
 * again while their transcript is still there.
 */

import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionUsage, UsageCall } from '../../platform/usage';

const NEWLINE = 0x0a;

/** A call in the ledger, and the session it was found in. */
export interface LedgerEntry {
  readonly sessionId: string;
  readonly folder: string | undefined;
  readonly call: UsageCall;
}

function sameCall(a: UsageCall, b: UsageCall): boolean {
  return (
    a.at === b.at &&
    a.model === b.model &&
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    (a.thinking === true) === (b.thinking === true)
  );
}

/** One line of the ledger: `calls` of the session `usage`. */
export function ledgerLine(usage: Pick<SessionUsage, 'sessionId' | 'folder'>, calls: readonly UsageCall[]): string {
  const rows = calls.map((call) => [
    call.id,
    call.at,
    call.model,
    call.input,
    call.output,
    call.cacheRead,
    call.cacheWrite,
    call.thinking ? 1 : 0,
  ]);
  return `${JSON.stringify({ s: usage.sessionId, ...(usage.folder === undefined ? {} : { f: usage.folder }), c: rows })}\n`;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** Adds the calls of ledger lines to `entries`, by call id; what is not a call is left out. */
export function parseLedger(text: string, entries: Map<string, LedgerEntry>): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const { s, f, c } = value as Record<string, unknown>;
    if (typeof s !== 'string' || !s || !Array.isArray(c)) {
      continue;
    }
    const folder = typeof f === 'string' && f ? f : undefined;
    for (const row of c) {
      if (!Array.isArray(row)) {
        continue;
      }
      const [id, at, model, input, output, cacheRead, cacheWrite, thinking] = row as unknown[];
      if (typeof id !== 'string' || !id || typeof at !== 'number' || !Number.isFinite(at) || typeof model !== 'string' || !model) {
        continue;
      }
      entries.set(id, {
        sessionId: s,
        folder,
        call: {
          id,
          at,
          model,
          input: count(input),
          output: count(output),
          cacheRead: count(cacheRead),
          cacheWrite: count(cacheWrite),
          ...(thinking === 1 ? { thinking: true } : {}),
        },
      });
    }
  }
}

export class UsageLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  /** Where the last complete line read ends. */
  private offset = 0;
  private grouped: SessionUsage[] | undefined;

  constructor(private readonly filePath: string) {}

  /**
   * Adds the calls of `sessions` it does not have to the file, and those of the same session
   * whose tokens changed. A call it has from another session is a copy (a forked conversation).
   */
  async record(sessions: Iterable<SessionUsage>): Promise<void> {
    await this.load();
    const lines: string[] = [];
    const batch = new Set<string>();
    for (const usage of sessions) {
      const calls = usage.calls.filter((call) => {
        if (call.id === undefined || batch.has(call.id)) {
          return false;
        }
        const known = this.entries.get(call.id);
        if (known && (known.sessionId !== usage.sessionId || sameCall(known.call, call))) {
          return false;
        }
        batch.add(call.id);
        return true;
      });
      if (calls.length > 0) {
        lines.push(ledgerLine(usage, calls));
      }
    }
    if (lines.length === 0) {
      return;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, lines.join(''), 'utf8');
    // Read back what was written (and what the other instance may have written meanwhile).
    await this.load();
  }

  /** Every call in the ledger, by session. */
  async sessions(): Promise<SessionUsage[]> {
    await this.load();
    if (!this.grouped) {
      const bySession = new Map<string, { folder: string | undefined; calls: UsageCall[] }>();
      for (const entry of this.entries.values()) {
        const session = bySession.get(entry.sessionId) ?? { folder: entry.folder, calls: [] };
        session.calls.push(entry.call);
        bySession.set(entry.sessionId, session);
      }
      this.grouped = [...bySession].map(([sessionId, { folder, calls }]) => ({ sessionId, folder, calls }));
    }
    return this.grouped;
  }

  /** Reads what was appended since the last time (by this worker or the other instance's). */
  private async load(): Promise<void> {
    const stats = await stat(this.filePath).catch(() => undefined);
    const size = stats?.isFile() ? stats.size : 0;
    if (size < this.offset) {
      // Rewritten (by hand): read it all again.
      this.entries.clear();
      this.offset = 0;
      this.grouped = undefined;
    }
    if (size === this.offset) {
      return;
    }
    const handle = await open(this.filePath, 'r').catch(() => undefined);
    if (!handle) {
      return;
    }
    const buffer = Buffer.alloc(size - this.offset);
    let read = 0;
    try {
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, this.offset + read);
        if (bytesRead === 0) {
          break;
        }
        read += bytesRead;
      }
    } finally {
      await handle.close();
    }
    // Up to the last newline: the other instance may be writing a line right now.
    const end = buffer.subarray(0, read).lastIndexOf(NEWLINE) + 1;
    if (end > 0) {
      parseLedger(buffer.toString('utf8', 0, end), this.entries);
      this.offset += end;
      this.grouped = undefined;
    }
  }
}
