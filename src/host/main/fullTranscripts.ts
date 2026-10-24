/**
 * A session's full transcript written out as a Markdown file (transcriptMarkdown.ts), for the
 * content pane's preview to open. Runs in the sessions worker: a transcript can be tens of MB.
 *
 * Each session's file goes in a folder of its own, `<transcripts>/<session id>/<title>.md`
 * (the tab shows the file's name), written again each time it is asked for. Folders untouched
 * for a week are removed then.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { isSessionId } from './sessionFiles';
import { sideTitle } from './sessionSearch';
import { indexSession, parseTranscript } from './sessionTranscripts';
import { transcriptMarkdown, type TranscriptLabels } from './transcriptMarkdown';

export interface FullTranscriptRequest {
  readonly sessionId: string;
  /** Where the files go (the transcripts folder). */
  readonly outDir: string;
  readonly labels: TranscriptLabels;
}

const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const FILE_NAME_CHARS = 80;

/** The session's transcript file under `projectsDir`, if there is one. */
async function findTranscript(projectsDir: string, sessionId: string): Promise<string | undefined> {
  const folders = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
  for (const folder of folders) {
    if (!folder.isDirectory()) {
      continue;
    }
    const file = path.join(projectsDir, folder.name, `${sessionId}.jsonl`);
    if ((await stat(file).catch(() => undefined))?.isFile()) {
      return file;
    }
  }
  return undefined;
}

/** The subagents' transcripts, by the id of the tool call that started each. */
async function subagentsOf(sessionDir: string): Promise<Map<string, string>> {
  const dir = path.join(sessionDir, 'subagents');
  const subagents = new Map<string, string>();
  for (const name of await readdir(dir).catch((): string[] => [])) {
    if (!name.endsWith('.meta.json')) {
      continue;
    }
    try {
      const meta: unknown = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      const toolUseId = typeof meta === 'object' && meta !== null ? (meta as { toolUseId?: unknown }).toolUseId : undefined;
      if (typeof toolUseId === 'string') {
        subagents.set(toolUseId, await readFile(path.join(dir, `${name.slice(0, -'.meta.json'.length)}.jsonl`), 'utf8'));
      }
    } catch {
      // One that cannot be read is left out.
    }
  }
  return subagents;
}

/** `title` as a file name Windows takes. */
export function fileNameOf(title: string, fallback: string): string {
  const name = title
    // Characters a Windows file name cannot have, and control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FILE_NAME_CHARS)
    // Nor end in a dot or a space.
    .replace(/[. ]+$/, '');
  return `${name || fallback}.md`;
}

/** Removes the other sessions' folders untouched for a week. */
async function prune(outDir: string, keep: string): Promise<void> {
  const now = Date.now();
  for (const entry of await readdir(outDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === keep) {
      continue;
    }
    const folder = path.join(outDir, entry.name);
    const modified = (await stat(folder).catch(() => undefined))?.mtimeMs;
    if (modified !== undefined && now - modified > KEPT_MS) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Writes the session's full transcript; its path, or undefined when the session is not found. */
export async function writeFullTranscript(projectsDir: string, request: FullTranscriptRequest): Promise<string | undefined> {
  const { sessionId, outDir } = request;
  if (!isSessionId(sessionId)) {
    return undefined;
  }
  const file = await findTranscript(projectsDir, sessionId);
  if (!file) {
    return undefined;
  }
  const text = await readFile(file, 'utf8');
  const sessionDir = file.slice(0, -'.jsonl'.length);
  const title = indexSession(sessionId, parseTranscript(text), 0, await sideTitle(sessionDir))?.title ?? sessionId;
  const markdown = transcriptMarkdown(text, { title, sessionId, labels: request.labels, subagents: await subagentsOf(sessionDir) });
  const folder = path.join(outDir, sessionId);
  await mkdir(folder, { recursive: true });
  // The title may have changed since the last time.
  const target = path.join(folder, fileNameOf(title, sessionId));
  for (const name of await readdir(folder)) {
    if (path.join(folder, name) !== target) {
      await rm(path.join(folder, name), { force: true }).catch(() => undefined);
    }
  }
  await writeFile(target, markdown, 'utf8');
  await prune(outDir, sessionId);
  return target;
}
