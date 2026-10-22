/**
 * While files are dragged over the window, a shade covers it and each place that takes them
 * says what dropping them there does; the one under the pointer lights up (VS Code's colors
 * for dropping into an editor).
 *
 * Pages in iframes get the drag events of their area, so the shell's boxes take them where the
 * shell handles the drop (the session list, the content pane). Over the conversation the box
 * lets them through: the page takes the files itself, as attachments, and its script tells
 * where the pointer is (`WebviewFrames.onDidDragFiles`). The drag is over when the shell's
 * document and every page have been left, when something was dropped, or when the mouse moves
 * again (no mouse events come during a drag).
 */

import type { Layout } from '../../core/layout';
import type { WebviewFrames } from '../../core/webviewFrames';
import { DisposableStore, toDisposable, type IDisposable } from '../../platform/lifecycle';
import { zoneAt, type DropAction, type DropZone, type ZoneRect } from './zones';

/** A place that takes files, as the module describes it when a drag starts (`rect` in the window). */
export interface ZoneSpec {
  readonly action: DropAction;
  readonly rect: ZoneRect;
  readonly title: string;
  readonly detail?: string;
  /** Cut from a place that does something else (the conversation): a line marks where. */
  readonly strip?: boolean;
}

/** Leaving one page or element for the next: the drag is over once nothing has it for this long (ms). */
const LEAVE_DELAY_MS = 100;

interface ShownZone extends DropZone {
  readonly box: HTMLElement;
}

export class FileDropOverlay implements IDisposable {
  private readonly root: HTMLElement;
  private readonly disposables = new DisposableStore();
  private zones: ShownZone[] = [];
  private shown = false;
  /** Elements of the shell's document the drag is in (enters come before the previous element's leave). */
  private depth = 0;
  /** Pages the drag is over. */
  private readonly framesOver = new Set<string>();
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    layout: Layout,
    frames: WebviewFrames,
    private readonly describe: () => readonly ZoneSpec[],
    /** Files dropped on a place the shell handles (not `attach`, which the page takes). */
    private readonly onDrop: (action: DropAction, files: readonly File[]) => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'file-drop';
    this.root.hidden = true;
    layout.overlays.appendChild(this.root);

    const listen = <K extends keyof DocumentEventMap>(type: K, listener: (event: DocumentEventMap[K]) => void): void => {
      document.addEventListener(type, listener, true);
      this.disposables.add(toDisposable(() => document.removeEventListener(type, listener, true)));
    };
    listen('dragenter', (event) => {
      if (hasFiles(event)) {
        this.depth++;
        this.over(event.clientX, event.clientY, event);
      }
    });
    listen('dragover', (event) => {
      if (hasFiles(event)) {
        this.over(event.clientX, event.clientY, event);
      }
    });
    listen('dragleave', (event) => {
      if (hasFiles(event)) {
        this.depth = Math.max(0, this.depth - 1);
        this.leaveSoon();
      }
    });
    listen('drop', (event) => {
      if (!hasFiles(event)) {
        return;
      }
      // Never the browser's own drop (it would open the file in place of the window).
      event.preventDefault();
      event.stopPropagation();
      const zone = this.zoneAt(event.clientX, event.clientY);
      const files = [...(event.dataTransfer?.files ?? [])];
      this.hide();
      if (zone && zone.action !== 'attach' && files.length > 0) {
        this.onDrop(zone.action, files);
      }
    });
    // No mouse events come during a drag: one means it ended without a word (cancelled elsewhere).
    listen('mousemove', () => this.shown && this.hide());
    this.disposables.add(
      frames.onDidDragFiles(({ webviewId, phase, x, y }) => {
        if (phase === 'drop' || phase === 'end') {
          this.hide();
        } else if (phase === 'leave') {
          this.framesOver.delete(webviewId);
          this.leaveSoon();
        } else {
          this.framesOver.add(webviewId);
          const origin = frames.element(webviewId)?.getBoundingClientRect();
          this.over((origin?.left ?? 0) + x, (origin?.top ?? 0) + y);
        }
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.leaveTimer);
    this.disposables.dispose();
    this.root.remove();
  }

  /** The pointer is at x, y of the window; `event`: the shell's own, which says whether it may drop here. */
  private over(x: number, y: number, event?: DragEvent): void {
    clearTimeout(this.leaveTimer);
    if (!this.shown) {
      this.show();
    }
    const zone = this.zoneAt(x, y);
    for (const candidate of this.zones) {
      candidate.box.classList.toggle('active', candidate === zone);
    }
    if (event?.dataTransfer) {
      // The shell drops only on its own places; the conversation's page is not under the shell's events.
      if (zone && zone.action !== 'attach') {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      } else {
        event.dataTransfer.dropEffect = 'none';
      }
    }
  }

  private zoneAt(x: number, y: number): ShownZone | undefined {
    return zoneAt(this.zones, x, y);
  }

  private leaveSoon(): void {
    clearTimeout(this.leaveTimer);
    this.leaveTimer = setTimeout(() => {
      if (this.depth === 0 && this.framesOver.size === 0) {
        this.hide();
      }
    }, LEAVE_DELAY_MS);
  }

  private show(): void {
    this.shown = true;
    this.zones = this.describe().flatMap((spec) =>
      spec.rect.right > spec.rect.left && spec.rect.bottom > spec.rect.top
        ? [{ action: spec.action, rect: spec.rect, box: this.box(spec) }]
        : [],
    );
    this.root.replaceChildren(...this.zones.map((zone) => zone.box));
    this.root.hidden = false;
  }

  private hide(): void {
    clearTimeout(this.leaveTimer);
    this.shown = false;
    this.depth = 0;
    this.framesOver.clear();
    this.zones = [];
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  /** A place's box: over pages it takes their drag events, except the conversation's, which takes the drop. */
  private box(spec: ZoneSpec): HTMLElement {
    const { rect } = spec;
    const box = document.createElement('div');
    box.className = `file-drop-zone${spec.action === 'attach' ? ' passes' : ''}${spec.strip ? ' strip' : ''}`;
    box.dataset.action = spec.action;
    Object.assign(box.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.right - rect.left}px`,
      height: `${rect.bottom - rect.top}px`,
    });
    const label = document.createElement('div');
    label.className = 'file-drop-label';
    const title = document.createElement('div');
    title.className = 'file-drop-title';
    title.textContent = spec.title;
    label.appendChild(title);
    if (spec.detail) {
      const detail = document.createElement('div');
      detail.className = 'file-drop-detail';
      detail.textContent = spec.detail;
      label.appendChild(detail);
    }
    box.appendChild(label);
    return box;
  }
}

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}

/** Where an element is in the window. */
export function rectOf(element: HTMLElement): ZoneRect {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
}
