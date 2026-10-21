/**
 * The files a conversation page links to (see FileLinkHints in platform/protocol.ts): a click
 * on one makes the page post a message that asks the extension to open the file. Two kinds of
 * click get the shell's say instead:
 *
 * - With Shift: the message posted during the click is held back, and the shell opens the file
 *   with its program (or passes the message on, when it cannot find the file).
 * - Right-click: the page's own menu (a Markdown link's "Copy Link") or none. This plays a
 *   click on the link with everything the page posts kept from the extension, which tells the
 *   file; the shell shows its menu for it, and "Open in Editor" passes the message on.
 */

import type { FileLinkHints } from '../../platform/protocol';
import { valueAt } from './streamMerge';

export interface FileLinkRequest {
  readonly id: number;
  readonly path: string;
  readonly intent: 'system' | 'menu';
  readonly link?: string;
}

export class FileLinks {
  private nextId = 1;
  private readonly held = new Map<number, unknown>();
  /** While a click is played: what the page posts meanwhile, kept from the extension. */
  private played: unknown[] | undefined;
  /** During a click with Shift (cleared once the click's handlers have run). */
  private shiftClick = false;

  constructor(
    private readonly hints: FileLinkHints,
    /** To the shell. */
    private readonly request: (request: FileLinkRequest) => void,
    /** To the extension, as the page would have posted it. */
    private readonly forward: (message: unknown) => void,
  ) {
    window.addEventListener(
      'click',
      (event) => {
        if (event.isTrusted && event.shiftKey) {
          this.shiftClick = true;
          setTimeout(() => (this.shiftClick = false));
        }
      },
      true,
    );
    window.addEventListener('contextmenu', (event) => this.onContextMenu(event), true);
  }

  /** A click is being played: its default action must not happen (a link would navigate). */
  get playing(): boolean {
    return this.played !== undefined;
  }

  /** The page posts `message` to the extension; true when this took it. */
  intercept(message: unknown): boolean {
    if (this.played) {
      this.played.push(message);
      return true;
    }
    if (!this.shiftClick || !this.isOpenRequest(message)) {
      return false;
    }
    const path = valueAt(message, this.hints.path);
    if (typeof path !== 'string') {
      return false;
    }
    this.request({ id: this.hold(message), path, intent: 'system' });
    return true;
  }

  /** The shell's answer about a held message: pass it on to the extension, or drop it. */
  answer(id: number, release: boolean): void {
    const message = this.held.get(id);
    this.held.delete(id);
    if (release && message !== undefined) {
      this.forward(message);
    }
  }

  private onContextMenu(event: MouseEvent): void {
    const element = event.target instanceof Element ? event.target.closest(this.hints.selector) : null;
    if (!element) {
      return;
    }
    const open = this.play(element).find((message) => this.isOpenRequest(message));
    const path = open === undefined ? undefined : valueAt(open, this.hints.path);
    if (typeof path !== 'string') {
      // No file behind it (a web link): the page's own menu.
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const href = element instanceof HTMLAnchorElement ? element.getAttribute('href') : null;
    this.request({ id: this.hold(open), path, intent: 'menu', link: href && href !== '#' ? href : undefined });
  }

  /** Clicks `element` the way the page takes a click; returns what the page posted for it. */
  private play(element: Element): unknown[] {
    const played: unknown[] = [];
    this.played = played;
    try {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, detail: 1 }));
    } finally {
      this.played = undefined;
    }
    return played;
  }

  private isOpenRequest(message: unknown): boolean {
    return this.hints.request.every(([path, value]) => valueAt(message, path) === value);
  }

  private hold(message: unknown): number {
    const id = this.nextId++;
    this.held.set(id, message);
    return id;
  }
}
