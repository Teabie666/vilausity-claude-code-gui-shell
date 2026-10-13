/**
 * Deleting a Claude Code session: what Claude Code keeps of it on disk. This is its own
 * storage, not an interface (looked at with Claude Code 2.1.296); under its folder
 * (`~/.claude`, or `CLAUDE_CONFIG_DIR`):
 *
 *   projects/<folder>/<session id>.jsonl   the transcript (what the session list shows)
 *   projects/<folder>/<session id>/        subagents' transcripts, tool results, the title file
 *   file-history/<session id>/             copies of the files it changed, for rewinding
 *   session-env/<session id>/              its environment
 *
 * The prompt history (`history.jsonl`, which the input box's arrow keys walk through) keeps
 * the session's prompts too; the CLI appends to it all the time, so it is left alone.
 *
 * A Claude Code process that runs a session keeps a record of itself while it runs
 * (claudeProcesses.ts).
 */

import { readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processRuns, sessionProcesses } from '../node/claudeProcesses';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude Code names sessions by UUID; anything else must never become part of a path. */
export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

/** What exists of `sessionId` under `projectsDir` and the folder that holds it; the transcripts last. */
export async function sessionPaths(projectsDir: string, sessionId: string): Promise<string[]> {
  if (!isSessionId(sessionId)) {
    throw new Error(`not a session id: ${sessionId}`);
  }
  let folders: string[] = [];
  try {
    folders = (await readdir(projectsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    // No projects at all.
  }
  const configDir = path.dirname(projectsDir);
  const candidates = [
    path.join(configDir, 'file-history', sessionId),
    path.join(configDir, 'session-env', sessionId),
    ...folders.map((folder) => path.join(projectsDir, folder, sessionId)),
    ...folders.map((folder) => path.join(projectsDir, folder, `${sessionId}.jsonl`)),
  ];
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      found.push(candidate);
    } catch {
      // Not kept for this session.
    }
  }
  return found;
}

/**
 * Waits until no Claude Code process runs `sessionId`, by their records (claudeProcesses.ts).
 * A tab of this window that showed it was closed before, and its process waited for. False
 * when one still runs after `timeoutMs`.
 */
export async function waitForSessionEnd(
  configDir: string,
  sessionId: string,
  timeoutMs: number,
  runs = processRuns,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ((await sessionProcesses(configDir, sessionId, runs)).length > 0) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(intervalMs);
  }
  return true;
}

export interface DeletedSession {
  readonly paths: readonly string[];
  /** A transcript was among them: the session lists no more. */
  readonly transcript: boolean;
}

/**
 * Deletes for good what Claude Code keeps of `sessionId`. The transcript goes last, so a
 * failure part way leaves a session that still lists and can be deleted again.
 */
export async function deleteSession(projectsDir: string, sessionId: string): Promise<DeletedSession> {
  const paths = await sessionPaths(projectsDir, sessionId);
  for (const target of paths) {
    // Retries: a virus scanner may hold a file for a moment.
    await rm(target, { recursive: true, force: true, maxRetries: 3 });
  }
  return { paths, transcript: paths.some((target) => target.endsWith('.jsonl')) };
}
