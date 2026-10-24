/**
 * A line in a long conversation where the page's leaving out of its earlier rows ends (see
 * OmittedRowsHints in platform/protocol.ts): "Earlier tool calls and thinking above are not
 * shown (...) · View Full Transcript", right after the latest row it left out, where one
 * scrolling up comes upon the first gap. The page's own messages tell what the conversation
 * has; the page shows each of Claude's messages with its uuid, so what it left out is what has
 * none.
 *
 * Only messages before the last one the page shows of those it may leave out count: after a
 * rewind the page drops the end of the conversation, which is not this. A page that shows none
 * of them shows another conversation (a new one started in it).
 */

import type { MessageMatch, OmittedRowsHints } from '../../platform/protocol';
import { valueAt } from './streamMerge';

/** Fewer left out than this is the page merging or hiding a few on its own (sure: none so far). */
export const MIN_OMITTED = 3;
/** The page is checked at most this often while it changes (ms). */
const CHECK_MS = 500;
const NOTICE_CLASS = 'vilaus-omitted-rows';

interface ConversationMessage {
  readonly uuid: string;
  /** One the page may leave out. */
  readonly omissible: boolean;
  /** One of the user's: it starts a turn. */
  readonly user: boolean;
}

/** Where the line goes: before the message the page shows with this uuid, or before its turn. */
export interface OmissionEnd {
  readonly uuid: string;
  /** A message of the user's comes first: the line goes before the turn it starts. */
  readonly beforeTurn: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const matches = (data: unknown, match: MessageMatch): boolean => match.every(([path, value]) => valueAt(data, path) === value);

/**
 * A message of the conversation as counted: a row (Claude's, or the user's other than tool
 * results), and whether the page may leave it out. Undefined for a subagent's, and for one
 * that is no row.
 */
export function rowOf(message: unknown, hints: Pick<OmittedRowsHints, 'blockTypes' | 'unseenTools'>): ConversationMessage | undefined {
  if (!isRecord(message) || typeof message.uuid !== 'string' || (message.parent_tool_use_id ?? null) !== null) {
    return undefined;
  }
  const content = isRecord(message.message) ? message.message.content : undefined;
  const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
  if (message.type === 'user') {
    return blocks.length > 0 && blocks.every((block) => block.type === 'tool_result')
      ? undefined
      : { uuid: message.uuid, omissible: false, user: true };
  }
  if (message.type !== 'assistant') {
    return undefined;
  }
  const omissible = blocks.some(
    (block) =>
      typeof block.type === 'string' &&
      hints.blockTypes.includes(block.type) &&
      !(block.type === 'tool_use' && typeof block.name === 'string' && hints.unseenTools.includes(block.name)),
  );
  return { uuid: message.uuid, omissible, user: false };
}

/**
 * Where the page's leaving out ends, given the uuids it shows: the first message it shows after
 * the latest one it left out. Undefined when it left out fewer than MIN_OMITTED (see the
 * file's comment for what counts).
 */
export function omissionEnd(messages: readonly ConversationMessage[], shown: ReadonlySet<string>, limit: number): OmissionEnd | undefined {
  if (messages.length <= limit) {
    return undefined;
  }
  let last = -1;
  messages.forEach((message, index) => {
    if (message.omissible && shown.has(message.uuid)) {
      last = index;
    }
  });
  let omitted = 0;
  let latest = -1;
  for (let index = 0; index < last; index++) {
    const message = messages[index];
    if (message?.omissible && !shown.has(message.uuid)) {
      omitted++;
      latest = index;
    }
  }
  if (omitted < MIN_OMITTED) {
    return undefined;
  }
  let beforeTurn = false;
  for (const message of messages.slice(latest + 1)) {
    beforeTurn ||= message.user;
    if (shown.has(message.uuid)) {
      return { uuid: message.uuid, beforeTurn };
    }
  }
  return undefined;
}

export class OmittedRows {
  /** The conversation's messages in order, each once. */
  private messages: ConversationMessage[] = [];
  private readonly known = new Set<string>();
  private readonly root: HTMLElement;
  private end: OmissionEnd | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly hints: OmittedRowsHints,
    labels: { readonly omittedRows: string; readonly fullTranscript: string },
    onOpen: () => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = NOTICE_CLASS;
    this.root.setAttribute('role', 'note');
    const text = document.createElement('span');
    text.className = `${NOTICE_CLASS}-text`;
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = labels.fullTranscript;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      onOpen();
    });
    text.append(labels.omittedRows.replace('{0}', String(hints.limit)), ' · ', link);
    this.root.append(text);
    // Clicks here are the shell's, not the conversation's.
    for (const type of ['click', 'mousedown']) {
      this.root.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  /** Watches the page as it renders (once there is a body). */
  start(): void {
    new MutationObserver((records) => {
      if (records.some((record) => record.target !== this.root && !this.root.contains(record.target))) {
        this.schedule();
      }
    }).observe(document.body, { subtree: true, childList: true });
    this.schedule();
  }

  /** A message the extension posted to the page. */
  observe(data: unknown): void {
    const { history, live } = this.hints;
    if (matches(data, history.match)) {
      const messages = valueAt(data, history.messages);
      if (Array.isArray(messages)) {
        this.messages = [];
        this.known.clear();
        messages.forEach((message) => this.add(message));
        this.schedule();
      }
    } else if (matches(data, live.match) && this.add(valueAt(data, live.message))) {
      this.schedule();
    }
  }

  private add(message: unknown): boolean {
    const row = rowOf(message, this.hints);
    if (!row || this.known.has(row.uuid)) {
      return false;
    }
    this.known.add(row.uuid);
    this.messages.push(row);
    return true;
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.check();
    }, CHECK_MS);
  }

  private check(): void {
    const attribute = this.hints.uuidAttribute;
    const shown = new Set<string>();
    for (const element of document.querySelectorAll(`[${attribute}]`)) {
      shown.add(element.getAttribute(attribute) ?? '');
    }
    this.end = omissionEnd(this.messages, shown, this.hints.limit);
    this.place();
  }

  /** Where the leaving out ends while there is something to say; out of the page otherwise. */
  private place(): void {
    const end = this.end;
    const message = end ? document.querySelector(`[${this.hints.uuidAttribute}="${CSS.escape(end.uuid)}"]`) : null;
    const before = end?.beforeTurn ? message?.closest(this.hints.turn) : message;
    if (!before?.parentElement) {
      this.root.remove();
      return;
    }
    if (before.previousElementSibling !== this.root) {
      before.parentElement.insertBefore(this.root, before);
    }
  }
}
