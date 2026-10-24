/**
 * Claude Code's session transcripts, read for the search: `<projects>/<folder key>/<session
 * id>.jsonl`, one JSON object per line. This is the CLI's own storage format, not an API
 * (checked against Claude Code 2.1.2xx), so it is read defensively: kinds of lines and
 * fields not known here are skipped, and a broken line is just one line less.
 *
 * What counts: the title, what the user typed and what Claude answered (not tool output,
 * thinking, or the context the IDE and the CLI add to a prompt), and the files Claude read
 * or changed.
 */

import type { SessionSearchMatch, SessionSearchResult, TextRange } from '../../platform/protocol';

export interface TranscriptMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface TranscriptFile {
  readonly path: string;
  /** Changed (Edit, Write...), not only read. */
  readonly edited: boolean;
}

export interface Transcript {
  /** Where the session started: the folder of the window it ran in. */
  readonly cwd: string | undefined;
  /** The user's name for the session (the last one given). */
  readonly customTitle: string | undefined;
  /** The name Claude Code generated (the latest). */
  readonly aiTitle: string | undefined;
  readonly messages: readonly TranscriptMessage[];
  readonly files: readonly TranscriptFile[];
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);
/**
 * Text blocks of a user message that are context, not typed: the IDE's open file and
 * selection, slash command records and output, reminders, task notifications.
 */
const CONTEXT_BLOCK =
  /^\s*<(ide_[a-z_]+|system-reminder|command-[a-z-]+|local-command-[a-z-]+|task-notification|bash-[a-z-]+|user-prompt-submit-hook)\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

const TYPE_KEY = '"type":"';
const TYPE_FIRST = `{${TYPE_KEY}`;
const USED_TYPES = new Set(['custom-title', 'ai-title', 'user', 'assistant']);
const MESSAGE_FIRST = '{"parentUuid":';
const USER_TYPE = `${TYPE_KEY}user"`;
const TOOL_RESULT_KEY = '"toolUseResult":';

/**
 * A line of an entry the search has no use for, told without parsing it: most of a
 * transcript's bytes, which the first read of them all would parse for nothing. A JSON string
 * holds no bare quote, so `"key":"` in a line is always structure, never text.
 *  - The CLI writes most kinds of entries with their type first, `{"type":"api-request",...`
 *    (requests it logs, file history, queue operations...: a quarter of the bytes).
 *  - A tool's result (two fifths: file contents, command output) is a user message with a
 *    `toolUseResult`: `{"parentUuid":...,"type":"user",...,"toolUseResult":...`, its type the
 *    first in the line. What the user types is text, so no other user message has the key.
 * Messages written some other way are parsed.
 */
function unusedEntry(line: string): boolean {
  if (line.startsWith(TYPE_FIRST)) {
    return !USED_TYPES.has(line.slice(TYPE_FIRST.length, line.indexOf('"', TYPE_FIRST.length)));
  }
  if (!line.startsWith(MESSAGE_FIRST)) {
    return false;
  }
  const type = line.indexOf(TYPE_KEY);
  return line.startsWith(USER_TYPE, type) && line.includes(TOOL_RESULT_KEY, type);
}

/**
 * What a transcript's lines tell, added to as more of them are read: a transcript only grows,
 * and one being written (a long conversation open somewhere) is read from where the last read
 * stopped rather than all over again.
 */
export class TranscriptReader {
  private cwd: string | undefined;
  private customTitle: string | undefined;
  private aiTitle: string | undefined;
  private readonly messages: TranscriptMessage[] = [];
  private readonly files = new Map<string, boolean>();

  /** Adds complete lines. */
  add(text: string): void {
    for (const line of text.split('\n')) {
      if (line.trim() && !unusedEntry(line)) {
        this.addLine(line);
      }
    }
  }

  /** What was read so far; later reads leave it as it is. */
  get transcript(): Transcript {
    return {
      cwd: this.cwd,
      customTitle: this.customTitle,
      aiTitle: this.aiTitle,
      messages: [...this.messages],
      files: [...this.files].map(([path, edited]) => ({ path, edited })),
    };
  }

  private addLine(line: string): void {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(entry)) {
      return;
    }
    if (entry.type === 'custom-title') {
      this.customTitle = nonEmptyString(entry.customTitle) ?? this.customTitle;
      return;
    }
    if (entry.type === 'ai-title') {
      this.aiTitle = nonEmptyString(entry.aiTitle) ?? this.aiTitle;
      return;
    }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain === true) {
      return;
    }
    this.cwd ??= nonEmptyString(entry.cwd);
    const role = entry.type;
    // Tool results, and messages the CLI adds for itself (meta, compaction summaries).
    if (
      role === 'user' &&
      (entry.toolUseResult !== undefined ||
        entry.isMeta === true ||
        entry.isCompactSummary === true ||
        entry.isVisibleInTranscriptOnly === true)
    ) {
      return;
    }
    const content = isRecord(entry.message) ? entry.message.content : undefined;
    const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (!isRecord(block)) {
        continue;
      }
      if (block.type === 'text') {
        const said = nonEmptyString(block.text);
        if (said && !(role === 'user' && CONTEXT_BLOCK.test(said))) {
          this.messages.push({ role, text: said.trim() });
        }
      } else if (role === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string' && isRecord(block.input)) {
        const edited = EDIT_TOOLS.has(block.name);
        const path = nonEmptyString(block.input.file_path) ?? nonEmptyString(block.input.notebook_path);
        if (path && (edited || READ_TOOLS.has(block.name))) {
          this.files.set(path, (this.files.get(path) ?? false) || edited);
        }
      }
    }
  }
}

export function parseTranscript(text: string): Transcript {
  const reader = new TranscriptReader();
  reader.add(text);
  return reader.transcript;
}

/** A session ready for searching: its transcript plus what the search compares in lower case. */
export interface IndexedSession {
  readonly sessionId: string;
  readonly title: string;
  readonly folder: string;
  readonly updatedAt: number;
  readonly messages: readonly TranscriptMessage[];
  readonly files: readonly TranscriptFile[];
  readonly lowerTitle: string;
  readonly lowerMessages: readonly string[];
  /** Paths with `/` separators, in lower case. */
  readonly lowerFiles: readonly string[];
}

const TITLE_FROM_PROMPT_LENGTH = 80;

/**
 * The searchable session, or undefined when there is nothing to show for it (nobody said
 * anything, or it is not known where it ran). The title is the user's name for it, else the
 * one in its side file (`<session id>/custom-title.json`), else the generated one, else the
 * start of the first prompt: close to how the extension's session list names it.
 */
export function indexSession(sessionId: string, transcript: Transcript, updatedAt: number, sideTitle?: string): IndexedSession | undefined {
  const firstPrompt = transcript.messages.find((message) => message.role === 'user')?.text;
  if (!transcript.cwd || (!firstPrompt && !transcript.customTitle && !transcript.aiTitle)) {
    return undefined;
  }
  const promptTitle = firstPrompt?.replace(/\s+/g, ' ').slice(0, TITLE_FROM_PROMPT_LENGTH);
  const title = transcript.customTitle ?? sideTitle ?? transcript.aiTitle ?? promptTitle ?? sessionId;
  return {
    sessionId,
    title,
    folder: transcript.cwd,
    updatedAt,
    messages: transcript.messages,
    files: transcript.files,
    lowerTitle: title.toLowerCase(),
    lowerMessages: transcript.messages.map((message) => message.text.toLowerCase()),
    lowerFiles: transcript.files.map((file) => file.path.replace(/\\/g, '/').toLowerCase()),
  };
}

/** Text shown before and after a match in a passage. */
const BEFORE = 40;
const AFTER = 160;

/** The passage of `text` around `[at, at + length)`, on one line, with the match's range in it. */
export function passage(text: string, at: number, length: number): { text: string; highlights: TextRange[] } {
  const start = Math.max(0, at - BEFORE);
  const end = Math.min(text.length, at + length + AFTER);
  const lead = start > 0 ? '…' : '';
  const body = text.slice(start, end).replace(/[\r\n\t]/g, ' ');
  const offset = at - start + lead.length;
  return { text: `${lead}${body}${end < text.length ? '…' : ''}`, highlights: [[offset, offset + length]] };
}

/** A file's path as shown: relative to the session's folder when inside it, `/` separators. */
export function displayPath(path: string, folder: string): string {
  const slashed = path.replace(/\\/g, '/');
  const base = folder.replace(/\\/g, '/').replace(/\/+$/, '');
  return slashed.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? slashed.slice(base.length + 1) : slashed;
}

function matchSession(session: IndexedSession, query: string): SessionSearchMatch | undefined {
  const inTitle = session.lowerTitle.indexOf(query);
  if (inTitle >= 0) {
    return { kind: 'title', highlights: [[inTitle, inTitle + query.length]] };
  }
  const slashedQuery = query.replace(/\\/g, '/');
  const fileIndex = session.lowerFiles.findIndex((path) => path.includes(slashedQuery));
  const file = session.files[fileIndex];
  if (file) {
    const shown = displayPath(file.path, session.folder);
    const at = shown.toLowerCase().indexOf(slashedQuery);
    return { kind: 'file', text: shown, edited: file.edited, highlights: at >= 0 ? [[at, at + query.length]] : [] };
  }
  for (const [index, lower] of session.lowerMessages.entries()) {
    const at = lower.indexOf(query);
    const message = session.messages[index];
    if (at >= 0 && message) {
      return { kind: 'content', role: message.role, ...passage(message.text, at, query.length) };
    }
  }
  return undefined;
}

const KIND_RANK = { title: 0, file: 1, content: 2 } as const;

/**
 * Sessions matching `query` (case-insensitive, as one piece): title matches first, then
 * files, then what was said; each kind newest first. An empty query lists the newest.
 */
export function searchSessions(sessions: Iterable<IndexedSession>, query: string, limit: number): SessionSearchResult[] {
  const needle = query.trim().toLowerCase();
  const results: SessionSearchResult[] = [];
  for (const session of sessions) {
    const result = { sessionId: session.sessionId, title: session.title, folder: session.folder, updatedAt: session.updatedAt };
    if (!needle) {
      results.push(result);
      continue;
    }
    const match = matchSession(session, needle);
    if (match) {
      results.push({ ...result, match });
    }
  }
  const rank = (result: SessionSearchResult): number => (result.match ? KIND_RANK[result.match.kind] : 0);
  return results.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt).slice(0, limit);
}
