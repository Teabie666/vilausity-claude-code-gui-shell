/**
 * A Markdown document's tab: the rendered preview by default, the Monaco source a toggle
 * away. Both views share the document's text model, so the preview follows edits.
 *
 * Text selected in the preview gets the selection menu (comments...) like the source does;
 * the preview marks where each block starts in the source to tell which lines it came from.
 */

import { Emitter } from '../../platform/event';
import { DisposableStore, toDisposable } from '../../platform/lifecycle';
import { workspaceImageUrl } from '../../platform/webviewUrls';
import type { ILogger } from '../../platform/log';
import type { RangeDto } from '../../platform/protocol';
import type { EditorHost, EditorInput, EditorPane, EditorSelectionContext, EditorTextSelection } from '../../core/editors';
import type { TextEditorService } from '../editor';
import { documentPath } from '../editor/selectionMenu';
import type { TextEditorPane, TextInputData } from '../editor/textEditorPane';
import { t } from './messages';
import { countLineBreaks, LINE_MARKER_ATTRIBUTE, lineMarker, locateLines, type SourceBlock } from './sourceLines';

const RENDER_DELAY_MS = 150;

type Mode = 'preview' | 'source';

export interface LinkHandler {
  /** An http(s) or mailto link. */
  openExternal(url: string): void;
  /** A link to another file, resolved against the document's folder. */
  openFile(path: string): void;
}

/** GitHub-style heading anchors: lower case, punctuation dropped, spaces to dashes. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

interface MarkdownRenderer {
  /** Sanitized HTML with a hidden line marker before each top-level block, and those blocks. */
  readonly render: (markdown: string) => { html: string; blocks: SourceBlock[] };
  readonly sanitize: (html: string) => string;
}

let renderer: Promise<MarkdownRenderer> | undefined;

/** marked + DOMPurify, loaded with the first preview. */
function loadRenderer(): Promise<MarkdownRenderer> {
  renderer ??= Promise.all([import('marked'), import('dompurify')]).then(([{ marked }, { default: purify }]) => ({
    render: (markdown) => {
      const tokens = marked.lexer(markdown, { gfm: true });
      const blocks: SourceBlock[] = [];
      const withMarkers: typeof tokens = Object.assign([], { links: tokens.links });
      let line = 1;
      for (const token of tokens) {
        if (token.type !== 'space') {
          blocks.push({ line, raw: token.raw });
          withMarkers.push({ type: 'html', block: true, pre: false, raw: '', text: lineMarker(line) });
        }
        withMarkers.push(token);
        line += countLineBreaks(token.raw);
      }
      return { html: purify.sanitize(marked.parser(withMarkers, { gfm: true, async: false })), blocks };
    },
    sanitize: (html) => purify.sanitize(html),
  }));
  return renderer;
}

/** The node a range boundary points at (an element boundary points between its children). */
function boundaryNode(container: Node, offset: number): Node {
  return container.nodeType === Node.ELEMENT_NODE ? (container.childNodes[offset] ?? container) : container;
}

export class MarkdownPane implements EditorPane {
  private mode: Mode = 'preview';
  private readonly source: TextEditorPane;
  private readonly preview: HTMLElement;
  /** The rendered document, inside the preview (which also holds the selection widgets). */
  private readonly body: HTMLElement;
  private readonly sourceContainer: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly toolbar: HTMLElement;
  private readonly disposables = new DisposableStore();
  private readonly textEditorsEmitter = new Emitter<void>();
  readonly onDidChangeTextEditors = this.textEditorsEmitter.event;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private renderedVersion = -1;
  private blocks: SourceBlock[] = [];
  /** The selection menu's buttons for a preview selection, and what commands showed instead. */
  private readonly menuWidget: HTMLElement;
  private readonly widgets = new Set<HTMLElement>();
  /** A reveal asked for before the preview was rendered. */
  private pendingReveal: { range: RangeDto; text: string } | undefined;

  constructor(
    container: HTMLElement,
    private readonly input: EditorInput,
    host: EditorHost,
    private readonly editors: TextEditorService,
    private readonly links: LinkHandler,
    private readonly logger: ILogger,
  ) {
    container.classList.add('text-editor-container');
    const toolbar = document.createElement('div');
    toolbar.className = 'editor-toolbar';
    this.toolbar = toolbar;
    const spacer = document.createElement('span');
    spacer.className = 'editor-toolbar-spacer';
    this.toggle = document.createElement('button');
    this.toggle.className = 'button secondary';
    this.toggle.addEventListener('click', () => this.setMode(this.mode === 'preview' ? 'source' : 'preview'));
    toolbar.append(spacer, this.toggle);

    this.preview = document.createElement('div');
    this.preview.className = 'markdown-preview';
    this.preview.tabIndex = 0;
    this.body = document.createElement('div');
    this.body.className = 'markdown-body';
    this.body.addEventListener('click', (event) => this.onClick(event));
    this.menuWidget = document.createElement('div');
    this.menuWidget.className = 'selection-widget preview-selection-widget';
    this.menuWidget.hidden = true;
    this.preview.append(this.body, this.menuWidget);
    this.preview.addEventListener('mousedown', (event) => {
      if (!this.isWidgetTarget(event.target)) {
        this.hideMenu();
      }
    });
    this.preview.addEventListener('mouseup', (event) => {
      if (!this.isWidgetTarget(event.target)) {
        // Once the click has updated the selection.
        setTimeout(() => this.showMenu());
      }
    });
    this.preview.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.menuWidget.hidden) {
        // The key closes the menu, not the tab (features/navigation).
        event.preventDefault();
        this.hideMenu();
      }
    });
    this.sourceContainer = document.createElement('div');
    this.sourceContainer.className = 'editor-body';
    container.append(toolbar, this.preview, this.sourceContainer);

    this.source = editors.createPane(this.sourceContainer, input, host);
    const model = this.source.editor.getModel();
    if (model) {
      this.disposables.add(model.onDidChangeContent(() => this.scheduleRender()));
    }
    this.applyMode();
  }

  get textEditorIds(): readonly string[] {
    // Like VS Code's preview (a webview), the rendered view is no text editor.
    return this.mode === 'source' ? this.source.textEditorIds : [];
  }

  get isSource(): boolean {
    return this.mode === 'source';
  }

  setMode(mode: Mode): void {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.applyMode();
    this.focus();
    this.textEditorsEmitter.fire();
  }

  /** Re-renders the preview (e.g. for a new color theme of its code blocks). */
  refresh(): void {
    this.renderedVersion = -1;
    this.scheduleRender();
  }

  /** Moves the preview (plain DOM) and the source editor (a new Monaco widget) into `container`. */
  relocate(container: HTMLElement): void {
    this.hideMenu();
    container.classList.add('text-editor-container');
    container.append(this.toolbar, this.preview, this.sourceContainer);
    this.source.relocate(this.sourceContainer);
  }

  layout(): void {
    this.source.layout();
  }

  setVisible(): void {}

  focus(): void {
    if (this.mode === 'source') {
      this.source.focus();
    } else {
      this.preview.focus();
    }
  }

  confirmClose(): Promise<boolean> {
    return this.source.confirmClose();
  }

  selectionContext(): EditorSelectionContext | undefined {
    if (this.mode === 'source') {
      return this.source.selectionContext();
    }
    const found = this.previewSelection();
    return found ? this.createContext(found.selection, found.anchor) : undefined;
  }

  revealSelection(uri: string, range: RangeDto, text: string): boolean {
    if (uri !== this.input.resource) {
      return false;
    }
    if (this.mode === 'source') {
      return this.source.revealSelection(uri, range);
    }
    const model = this.source.editor.getModel();
    if (model && model.getVersionId() !== this.renderedVersion) {
      this.pendingReveal = { range, text };
    } else {
      this.revealInPreview(range, text);
    }
    return true;
  }

  dispose(): void {
    clearTimeout(this.renderTimer);
    this.disposables.dispose();
    this.textEditorsEmitter.dispose();
    this.source.dispose();
  }

  private applyMode(): void {
    const preview = this.mode === 'preview';
    this.preview.hidden = !preview;
    this.sourceContainer.hidden = preview;
    this.toggle.textContent = preview ? t('openSource') : t('openPreview');
    if (preview) {
      this.scheduleRender(0);
    } else {
      this.hideMenu();
      this.source.layout();
    }
  }

  private scheduleRender(delay = RENDER_DELAY_MS): void {
    if (this.mode !== 'preview') {
      return;
    }
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => void this.render().catch((error: unknown) => this.logger.error('rendering the preview failed', error)), delay);
  }

  private async render(): Promise<void> {
    const model = this.source.editor.getModel();
    if (!model || model.getVersionId() === this.renderedVersion) {
      return;
    }
    const version = model.getVersionId();
    const { render } = await loadRenderer();
    const scroll = this.preview.scrollTop;
    const { html, blocks } = render(model.getValue());
    this.body.innerHTML = html;
    this.blocks = blocks;
    this.renderedVersion = version;
    for (const heading of this.body.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      heading.id ||= slugify(heading.textContent ?? '');
    }
    this.resolveImages();
    this.preview.scrollTop = scroll;
    const reveal = this.pendingReveal;
    this.pendingReveal = undefined;
    if (reveal) {
      this.revealInPreview(reveal.range, reveal.text);
    }
    await this.highlightCodeBlocks();
  }

  private async highlightCodeBlocks(): Promise<void> {
    const { sanitize } = await loadRenderer();
    for (const code of this.body.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
      const language = /language-([\w#+.-]+)/.exec(code.className)?.[1];
      const pre = code.parentElement;
      if (!language || !pre) {
        continue;
      }
      const html = await this.editors.codeToHtml(code.textContent ?? '', language);
      if (html && pre.isConnected) {
        // Shiki escapes the code; sanitize anyway, it ends up in the shell's page.
        pre.outerHTML = sanitize(html);
      }
    }
  }

  /** The folder of the document, for relative links and images. */
  private get folder(): string {
    return (this.input.tooltip ?? '').replace(/[\\/][^\\/]*$/, '');
  }

  /** Relative image paths point into the workspace, which main serves to the shell (`ccw://img`). */
  private resolveImages(): void {
    for (const image of this.body.querySelectorAll('img')) {
      const source = image.getAttribute('src');
      if (!source || /^[a-z][\w+.-]*:/i.test(source) || source.startsWith('//')) {
        continue; // https:, data:... stay as they are.
      }
      const relative = decodeURIComponent(source.split(/[?#]/, 1)[0]!);
      const absolute = /^([a-z]:)?[\\/]/i.test(relative) ? relative : `${this.folder}/${relative}`;
      image.src = workspaceImageUrl(absolute);
    }
  }

  private onClick(event: MouseEvent): void {
    const anchor = (event.target as Element | null)?.closest('a');
    const href = anchor?.getAttribute('href');
    if (!anchor || !href) {
      return;
    }
    event.preventDefault();
    if (href.startsWith('#')) {
      this.body.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)?.scrollIntoView();
    } else if (/^(https?|mailto):/i.test(href)) {
      this.links.openExternal(href);
    } else if (!/^[a-z][\w+.-]*:/i.test(href)) {
      this.links.openFile(`${this.folder}/${decodeURIComponent(href.split('#')[0]!)}`);
    }
  }

  // ---- selections in the preview -------------------------------------------------------

  private isWidgetTarget(target: EventTarget | null): boolean {
    const node = target instanceof Node ? target : null;
    return node !== null && (this.menuWidget.contains(node) || [...this.widgets].some((widget) => widget.contains(node)));
  }

  /** The preview's selection, with the source lines it came from and where to put widgets. */
  private previewSelection(): { selection: EditorTextSelection; anchor: { left: number; top: number } } | undefined {
    const selection = this.preview.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return undefined;
    }
    const range = selection.getRangeAt(0);
    const text = selection.toString();
    if (!this.body.contains(range.commonAncestorContainer) || text.trim() === '') {
      return undefined;
    }
    const lines = locateLines(this.blockAt(boundaryNode(range.startContainer, range.startOffset)), text);
    const snapshot = (this.input.data as TextInputData).document;
    const rects = range.getClientRects();
    const end = rects[rects.length - 1] ?? range.getBoundingClientRect();
    const frame = this.preview.getBoundingClientRect();
    return {
      selection: {
        text,
        uri: snapshot.uri,
        path: documentPath(snapshot),
        range: { start: { line: lines.start - 1, character: 0 }, end: { line: lines.end - 1, character: lines.endLength } },
      },
      anchor: {
        left: end.right - frame.left + this.preview.scrollLeft,
        top: end.bottom - frame.top + this.preview.scrollTop + 4,
      },
    };
  }

  /** The block a node of the rendered document belongs to: the last line marker before it. */
  private blockAt(node: Node): SourceBlock {
    let line: number | undefined;
    for (const marker of this.body.querySelectorAll(`[${LINE_MARKER_ATTRIBUTE}]`)) {
      if (marker.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
        line = Number(marker.getAttribute(LINE_MARKER_ATTRIBUTE));
      } else {
        break;
      }
    }
    return this.blocks.find((block) => block.line === line) ?? this.blocks[0] ?? { line: 1, raw: '' };
  }

  private showMenu(): void {
    const found = this.mode === 'preview' ? this.previewSelection() : undefined;
    const toolbar = found && this.editors.selectionMenu.createToolbar(this.preview.ownerDocument, this.createContext(found.selection, found.anchor));
    if (!found || !toolbar) {
      this.hideMenu();
      return;
    }
    this.menuWidget.replaceChildren(toolbar);
    this.place(this.menuWidget, found.anchor);
  }

  private hideMenu(): void {
    this.menuWidget.hidden = true;
    this.menuWidget.replaceChildren();
  }

  /** Puts a widget at `anchor` (preview content coordinates), kept inside the preview's width. */
  private place(widget: HTMLElement, anchor: { left: number; top: number }): void {
    widget.hidden = false;
    widget.style.top = `${anchor.top}px`;
    widget.style.left = '0px';
    const room = this.preview.scrollLeft + this.preview.clientWidth - widget.offsetWidth - 4;
    widget.style.left = `${Math.max(this.preview.scrollLeft, Math.min(anchor.left, room))}px`;
  }

  private createContext(selection: EditorTextSelection, anchor: { left: number; top: number }): EditorSelectionContext {
    return {
      selection,
      showWidget: (element) => {
        this.hideMenu();
        const widget = this.preview.ownerDocument.createElement('div');
        widget.className = 'selection-widget preview-selection-widget';
        widget.appendChild(element);
        this.preview.appendChild(widget);
        this.widgets.add(widget);
        this.place(widget, anchor);
        return toDisposable(() => {
          widget.remove();
          this.widgets.delete(widget);
        });
      },
    };
  }

  /** Scrolls to the block of `range` and selects `text` in it when it can be found. */
  private revealInPreview(range: RangeDto, text: string): void {
    const line = range.start.line + 1;
    const markers = [...this.body.querySelectorAll(`[${LINE_MARKER_ATTRIBUTE}]`)];
    const index = markers.findLastIndex((marker) => Number(marker.getAttribute(LINE_MARKER_ATTRIBUTE)) <= line);
    const marker = markers[Math.max(0, index)];
    if (!marker) {
      return;
    }
    const next = markers[Math.max(0, index) + 1];
    const needle = text.replace(/\s+/g, ' ').trim().slice(0, 40);
    const walker = this.body.ownerDocument.createTreeWalker(this.body, NodeFilter.SHOW_TEXT);
    walker.currentNode = marker;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (next && next.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
        break;
      }
      const at = needle ? (node.textContent ?? '').indexOf(needle) : -1;
      if (at >= 0) {
        this.preview.focus();
        this.preview.ownerDocument.getSelection()?.setBaseAndExtent(node, at, node, at + needle.length);
        node.parentElement?.scrollIntoView({ block: 'center' });
        return;
      }
    }
    (marker.nextElementSibling ?? marker.parentElement)?.scrollIntoView({ block: 'center' });
    this.preview.focus();
  }
}
