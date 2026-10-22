/**
 * Comments on the text of a conversation, in its page (see ConversationCommentHints). Text
 * selected within one message gets a Comment button, like a selection in the editor; a click
 * hands the selection to the shell, which opens its comment form there. The text comments are
 * on stays faintly highlighted until they go out, and the shell has it scrolled into view and
 * flashed when a comment's source is clicked. The place of the text is its message (Claude's by
 * uuid, the user's by turn) and where the quote starts in the message's text; it is found again
 * by the quote, nearest to that place, as the page renders the conversation anew.
 */

import type {
  ConversationCommentHints,
  ConversationPlaceDto,
  ConversationQuoteDto,
  ConversationSelectionDto,
  RectDto,
} from '../../platform/protocol';
import { scrollerOf } from './scrollKeeper';

/** Highlight names (CSS Custom Highlight API): the commented text, and the flash on revealing it. */
const QUOTED = 'vilaus-comment';
const FLASHED = 'vilaus-comment-flash';
/** The flash: on, off, on (ms). */
const FLASH_MS = [500, 200, 600] as const;
/** After opening the thinking, the page renders it in a few frames (ms). */
const THINKING_OPEN_MS = 150;

// The codicon `comment`, drawn as a mask filled with the text color.
const COMMENT_ICON =
  'M1 4.5C1 3.11929 2.11929 2 3.5 2H12.5C13.8807 2 15 3.11929 15 4.5V9.5C15 10.8807 13.8807 12 12.5 12H8.68787L5.62533 14.6797C4.99168 15.2342 4 14.7842 4 13.9422V12H3.5C2.11929 12 1 10.8807 1 9.5V4.5ZM3.5 3C2.67157 3 2 3.67157 2 4.5V9.5C2 10.3284 2.67157 11 3.5 11H5V13.8981L8.31213 11H12.5C13.3284 11 14 10.3284 14 9.5V4.5C14 3.67157 13.3284 3 12.5 3H3.5Z';

/**
 * The button looks like the shell's selection menu (a button of the theme, VS Code's small
 * corners and large shadow, which the page has no variables for); the commented text takes
 * the color VS Code gives text that comments are on.
 */
const STYLES = `
::highlight(${QUOTED}) {
  background-color: var(--vscode-editorCommentsWidget-rangeBackground, var(--vscode-editor-findRangeHighlightBackground));
}
::highlight(${FLASHED}) {
  background-color: var(--vscode-editor-findMatchHighlightBackground);
}
.vilaus-comment-button {
  position: fixed;
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  margin: 0;
  padding: 0 8px 0 6px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  box-shadow: 0 0 12px rgba(0, 0, 0, 0.14);
  font-family: var(--vscode-font-family);
  font-size: 12px;
  line-height: normal;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.vilaus-comment-button[hidden] { display: none; }
.vilaus-comment-button:hover { background: var(--vscode-button-hoverBackground); }
.vilaus-comment-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.vilaus-comment-button::before {
  content: '';
  width: 14px;
  height: 14px;
  background-color: currentColor;
  mask: url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="${COMMENT_ICON}"/></svg>`)}") center / 14px no-repeat;
}
`;

/** Events the page must not see from the button. */
const SHIELDED_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'] as const;

/** Where a message's words are: the element, and where in the conversation (all but the offset). */
interface TextRoot {
  readonly root: Element;
  readonly place: Omit<ConversationPlaceDto, 'offset'>;
}

export class ConversationQuotes {
  private readonly button: HTMLButtonElement;
  /** The selection the button is shown for. */
  private shownFor: Range | undefined;
  private quotes: readonly ConversationQuoteDto[] = [];
  /** Where each quote was last found, by `JSON.stringify` of it. */
  private found = new Map<string, Range>();
  private observer: MutationObserver | undefined;
  private scheduled = false;
  private flashTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly hints: ConversationCommentHints,
    label: string,
    /** To the shell: the selection to comment on (null: none), with the id of the shell's request. */
    private readonly report: (selection: ConversationSelectionDto | null, id?: number) => void,
  ) {
    const style = document.createElement('style');
    style.id = '_vilausQuoteStyles';
    style.textContent = STYLES;
    document.head.appendChild(style);

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'vilaus-comment-button';
    this.button.dataset.vilaus = 'comment-selection';
    this.button.textContent = label;
    this.button.hidden = true;
    // The selection stays, and the focus where it is.
    this.button.addEventListener('mousedown', (event) => event.preventDefault());
    this.button.addEventListener('click', () => {
      const selection = this.selection();
      this.hideButton();
      if (selection) {
        this.report(selection);
      }
    });
    for (const type of SHIELDED_EVENTS) {
      this.button.addEventListener(type, (event) => event.stopPropagation());
    }
    document.body.appendChild(this.button);

    // Shown when a mouse selection ends, gone when the next one starts or the selection goes.
    window.addEventListener(
      'mousedown',
      (event) => {
        if (event.target !== this.button) {
          this.hideButton();
        }
      },
      true,
    );
    window.addEventListener(
      'mouseup',
      (event) => {
        if (event.button === 0 && event.target !== this.button) {
          // Once the click has updated the selection.
          setTimeout(() => this.showButton());
        }
      },
      true,
    );
    document.addEventListener('selectionchange', () => {
      if (this.shownFor && getSelection()?.isCollapsed !== false) {
        this.hideButton();
      }
    });
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && !this.button.hidden) {
          // Hiding it changes the page: the shell does not take the key for itself either.
          this.hideButton();
        }
      },
      true,
    );
    document.addEventListener('scroll', () => this.placeButton(), { capture: true, passive: true });
    window.addEventListener('resize', () => this.placeButton());
  }

  /** The commented text to highlight. */
  setQuotes(quotes: readonly ConversationQuoteDto[]): void {
    this.quotes = quotes;
    if (quotes.length === 0) {
      this.observer?.disconnect();
      this.observer = undefined;
      this.found.clear();
      CSS.highlights?.delete(QUOTED);
      return;
    }
    if (!this.observer) {
      // The page renders the conversation anew as it goes: find the text again.
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    this.refresh();
  }

  /** Answers the shell's request (a keybinding) with the selection to comment on. */
  answer(id: number): void {
    const selection = this.selection();
    this.hideButton();
    this.report(selection ?? null, id);
  }

  /** Scrolls commented text into view and flashes it; thinking is opened first. */
  reveal(quote: ConversationQuoteDto): void {
    const range = this.locate(quote);
    if (!range) {
      return;
    }
    const element = boundaryElement(range.startContainer);
    if (quote.place.role === 'thinking' && element && !element.checkVisibility()) {
      // In a closed thinking block (its text still has boxes): open them (one state for all), then look again.
      const message = element.closest(this.hints.message);
      message?.querySelector<HTMLElement>(this.hints.thinkingToggle)?.click();
      setTimeout(() => {
        const opened = this.locate(quote);
        if (opened) {
          this.show(opened);
        }
      }, THINKING_OPEN_MS);
      return;
    }
    this.show(range);
  }

  private show(range: Range): void {
    const element = boundaryElement(range.startContainer);
    const scroller = element && scrollerOf(element);
    if (scroller) {
      // In the middle of the conversation (a long quote: its top near the top).
      const view = scroller.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      const margin = Math.max(24, (view.height - rect.height) / 2);
      scroller.scrollTo({ top: scroller.scrollTop + rect.top - view.top - margin, behavior: 'smooth' });
    }
    this.flash(range);
  }

  private flash(range: Range): void {
    this.flashTimers.forEach(clearTimeout);
    if (!CSS.highlights) {
      return;
    }
    const on = (): void => void CSS.highlights.set(FLASHED, new Highlight(range));
    const off = (): void => void CSS.highlights.delete(FLASHED);
    const [first, gap, second] = FLASH_MS;
    on();
    this.flashTimers = [setTimeout(off, first), setTimeout(on, first + gap), setTimeout(off, first + gap + second)];
  }

  private schedule(): void {
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => {
        this.scheduled = false;
        this.refresh();
      });
    }
  }

  /** Highlights the quotes, found again where the page changed under them. */
  private refresh(): void {
    const found = new Map<string, Range>();
    for (const quote of this.quotes) {
      const key = JSON.stringify(quote);
      const previous = this.found.get(key);
      const range = previous && stillQuotes(previous, quote.quote) ? previous : this.locate(quote);
      if (range) {
        found.set(key, range);
      }
    }
    this.found = found;
    if (this.quotes.length > 0) {
      CSS.highlights?.set(QUOTED, new Highlight(...found.values()));
    }
  }

  // ---- the selection --------------------------------------------------------------------

  /** The text selected within one message, unless none is. */
  private selection(): ConversationSelectionDto | undefined {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return undefined;
    }
    const range = selection.getRangeAt(0);
    const quote = selection.toString();
    const start = this.textRoot(range.startContainer);
    if (quote.trim() === '' || !start || start.root !== this.textRoot(range.endContainer)?.root) {
      return undefined;
    }
    const before = document.createRange();
    before.setStart(start.root, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const rects = range.getClientRects();
    const end = rects[rects.length - 1] ?? range.getBoundingClientRect();
    return { quote, place: { ...start.place, offset: before.toString().length }, rect: toRect(end) };
  }

  private showButton(): void {
    const selection = getSelection();
    if (!this.selection() || !selection) {
      this.hideButton();
      return;
    }
    this.shownFor = selection.getRangeAt(0);
    this.button.hidden = false;
    this.placeButton();
  }

  private hideButton(): void {
    this.shownFor = undefined;
    this.button.hidden = true;
  }

  /** Below the end of the selection, inside the window; gone when the selection scrolls out of view. */
  private placeButton(): void {
    const range = this.shownFor;
    if (!range) {
      return;
    }
    const rects = range.getClientRects();
    const end = rects[rects.length - 1];
    const element = boundaryElement(range.endContainer);
    const view = element && scrollerOf(element)?.getBoundingClientRect();
    if (!end || (view && (end.bottom < view.top || end.top > view.bottom))) {
      this.button.style.visibility = 'hidden';
      return;
    }
    this.button.style.visibility = '';
    const width = this.button.offsetWidth;
    const height = this.button.offsetHeight;
    const below = end.bottom + 4;
    const top = below + height > window.innerHeight - 4 ? end.top - height - 4 : below;
    this.button.style.left = `${Math.round(Math.max(4, Math.min(end.right, window.innerWidth - width - 4)))}px`;
    this.button.style.top = `${Math.round(Math.max(4, top))}px`;
  }

  /** The words of a message that `node` is in, and where they are in the conversation. */
  private textRoot(node: Node): TextRoot | undefined {
    const element = boundaryElement(node);
    const message = element?.closest(this.hints.message);
    if (!element || !message) {
      return undefined;
    }
    const turn = this.turnOf(message);
    const userText = element.closest(this.hints.userText);
    if (userText && message.contains(userText)) {
      return { root: userText, place: { role: 'user', turn } };
    }
    const uuid = message.getAttribute(this.hints.uuidAttribute);
    if (!uuid) {
      // The user's message, but not its words (its heading or time).
      return undefined;
    }
    const thinking = element.closest(this.hints.thinking);
    if (thinking && message.contains(thinking)) {
      return { root: thinking, place: { role: 'thinking', uuid, turn } };
    }
    return { root: message, place: { role: 'reply', uuid, turn } };
  }

  private turnOf(element: Element): number {
    const turn = element.closest(this.hints.turn);
    return turn ? Math.max(0, [...document.querySelectorAll(this.hints.turn)].indexOf(turn)) : 0;
  }

  // ---- finding a quote again ------------------------------------------------------------

  /** The quote in its message; else in another message of its kind, the nearest turn first. */
  private locate({ quote, place }: ConversationQuoteDto): Range | undefined {
    const own = this.rootsAt(place);
    const others = this.rootsOf(place.role)
      .filter((candidate) => !own.includes(candidate.root))
      .sort((a, b) => Math.abs(a.place.turn - place.turn) - Math.abs(b.place.turn - place.turn));
    const tries = [...own.map((root) => [root, place.offset] as const), ...others.map(({ root }) => [root, 0] as const)];
    for (const [root, near] of tries) {
      const text = textNodes(root);
      const match = findQuote(text.map((node) => node.data).join(''), quote, near);
      if (match) {
        return rangeOf(text, match);
      }
    }
    return undefined;
  }

  /**
   * The elements of the message a place names. One message of Claude's may show as several
   * elements with its uuid, and one element may hold thinking and a reply.
   */
  private rootsAt(place: ConversationPlaceDto): Element[] {
    if (place.role === 'user') {
      const text = document.querySelectorAll(this.hints.turn)[place.turn]?.querySelector(this.hints.userText);
      return text ? [text] : [];
    }
    if (!place.uuid) {
      return [];
    }
    const messages = [...document.querySelectorAll(`[${this.hints.uuidAttribute}="${CSS.escape(place.uuid)}"]`)];
    return place.role === 'thinking' ? messages.flatMap((message) => [...message.querySelectorAll(this.hints.thinking)]) : messages;
  }

  /** Every message's words of one kind. */
  private rootsOf(role: ConversationPlaceDto['role']): TextRoot[] {
    const selector = role === 'user' ? this.hints.userText : role === 'thinking' ? this.hints.thinking : `[${this.hints.uuidAttribute}]`;
    return [...document.querySelectorAll(selector)].flatMap((element) => {
      const found = this.textRoot(element);
      return found?.place.role === role && found.root === element ? [found] : [];
    });
  }
}

/**
 * Where `quote` is in `text`, the occurrence nearest to `near` when it is there several times.
 * White space is loose: a selection's text has line breaks between blocks where the page's
 * text may have none, and the other way round.
 */
export function findQuote(text: string, quote: string, near: number): { start: number; end: number } | undefined {
  const words = quote.split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) {
    return undefined;
  }
  const pattern = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'g');
  let best: { start: number; end: number } | undefined;
  for (const match of text.matchAll(pattern)) {
    if (!best || Math.abs(match.index - near) < Math.abs(best.start - near)) {
      best = { start: match.index, end: match.index + match[0].length };
    }
  }
  return best;
}

/** Whether a range found before still holds the quote (the page may have replaced its text). */
function stillQuotes(range: Range, quote: string): boolean {
  const squeeze = (text: string): string => text.replace(/\s+/g, '');
  return range.startContainer.isConnected && range.endContainer.isConnected && squeeze(range.toString()) === squeeze(quote);
}

function textNodes(root: Element): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

/** The range of `text` (the nodes' text joined) from `start` to `end`. */
function rangeOf(nodes: readonly Text[], { start, end }: { start: number; end: number }): Range | undefined {
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const length = node.data.length;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return undefined;
}

function boundaryElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function toRect(rect: DOMRect): RectDto {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
