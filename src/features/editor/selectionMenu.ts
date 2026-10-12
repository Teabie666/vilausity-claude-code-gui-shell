/**
 * The `editor/selection` menu (MenuId.EditorSelection): buttons that float next to text the
 * user selected, like the Add Comment button of the extension's plan preview. Commands get
 * an EditorSelectionContext and may show UI of their own in the buttons' place.
 *
 * SelectionMenu builds the buttons; MonacoSelectionWidget keeps them next to a Monaco
 * editor's selection (other views, e.g. the Markdown preview, place them themselves).
 */

import { URI } from 'vscode-uri';
import type { CommandService } from '../../core/commands';
import type { EditorSelectionContext, EditorTextSelection } from '../../core/editors';
import { MenuId, type MenuService } from '../../core/menus';
import { DisposableStore, toDisposable, type IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { DocumentSnapshot } from '../../platform/protocol';
import type { MonacoApi } from './monaco';
import { fromMonacoRange } from './textModels';

type CodeEditor = ReturnType<MonacoApi['editor']['create']>;
type MonacoPosition = { lineNumber: number; column: number };

/** A keyboard selection gets its buttons once the keys rest this long. */
const KEYBOARD_DELAY_MS = 400;

export class SelectionMenu {
  constructor(
    private readonly menus: MenuService,
    private readonly commands: CommandService,
    private readonly logger: ILogger,
  ) {}

  /** The menu's buttons for a selection, or undefined while no item applies. */
  createToolbar(doc: Document, context: EditorSelectionContext): HTMLElement | undefined {
    const groups = this.menus.getGroups(MenuId.EditorSelection);
    if (groups.length === 0) {
      return undefined;
    }
    const toolbar = doc.createElement('div');
    toolbar.className = 'selection-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    groups.forEach((group, index) => {
      if (index > 0) {
        const separator = doc.createElement('span');
        separator.className = 'selection-toolbar-separator';
        toolbar.appendChild(separator);
      }
      for (const item of group) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'selection-toolbar-button';
        button.dataset.command = item.command;
        if (item.icon) {
          const icon = doc.createElement('span');
          icon.className = `selection-toolbar-icon icon-${item.icon}`;
          button.appendChild(icon);
        }
        const label = doc.createElement('span');
        label.textContent = item.title;
        button.appendChild(label);
        // The selection and the focus stay in the editor.
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => {
          this.commands.execute(item.command, context).catch((error: unknown) => this.logger.warn(`${item.command} failed`, error));
        });
        toolbar.appendChild(button);
      }
    });
    return toolbar;
  }
}

/** The path of a document's file for labels: its file system path, also for other schemes (diff sides). */
export function documentPath(document: DocumentSnapshot): string {
  return document.uri.startsWith('file:') ? document.path : URI.parse(document.uri).fsPath;
}

/** The primary selection of a Monaco editor on `document`, unless it is empty or blank. */
export function monacoSelection(editor: CodeEditor, document: DocumentSnapshot): EditorTextSelection | undefined {
  const selection = editor.getSelection();
  const model = editor.getModel();
  if (!selection || !model || selection.isEmpty()) {
    return undefined;
  }
  const text = model.getValueInRange(selection);
  if (text.trim() === '') {
    return undefined;
  }
  return { text, uri: document.uri, path: documentPath(document), range: fromMonacoRange(selection) };
}

class AnchoredWidget {
  private position: MonacoPosition | undefined;
  private added = false;

  constructor(
    private readonly monaco: MonacoApi,
    private readonly editor: CodeEditor,
    readonly id: string,
    readonly node: HTMLElement,
  ) {}

  show(position: MonacoPosition): void {
    this.position = position;
    if (this.added) {
      this.editor.layoutContentWidget(this.widget);
    } else {
      this.editor.addContentWidget(this.widget);
      this.added = true;
    }
  }

  /** Lays it out again, e.g. after its content changed size. */
  layout(): void {
    if (this.added) {
      this.editor.layoutContentWidget(this.widget);
    }
  }

  hide(): void {
    if (this.added) {
      this.editor.removeContentWidget(this.widget);
      this.added = false;
    }
  }

  get visible(): boolean {
    return this.added;
  }

  private readonly widget = {
    allowEditorOverflow: true,
    getId: () => this.id,
    getDomNode: () => this.node,
    getPosition: () =>
      this.position
        ? {
            position: this.position,
            preference: [this.monaco.editor.ContentWidgetPositionPreference.BELOW, this.monaco.editor.ContentWidgetPositionPreference.ABOVE],
          }
        : null,
  };
}

let widgetCount = 0;

/**
 * Shows the selection menu next to a Monaco editor's selection: when a mouse selection
 * ends, or when a keyboard selection rests. Commands can put their own UI in its place
 * (`EditorSelectionContext.showWidget`), anchored where the menu was.
 */
export class MonacoSelectionWidget implements IDisposable {
  private readonly disposables = new DisposableStore();
  private readonly toolbarNode: HTMLElement;
  private readonly toolbar: AnchoredWidget;
  private readonly custom = new Set<AnchoredWidget>();
  private keyboardTimer: ReturnType<typeof setTimeout> | undefined;
  private mouseSelecting = false;
  private readonly id = ++widgetCount;

  constructor(
    private readonly monaco: MonacoApi,
    private readonly editor: CodeEditor,
    private readonly menu: SelectionMenu,
    /** The editor's selection as the menu's commands get it; undefined when there is none to act on. */
    private readonly describe: () => EditorTextSelection | undefined,
  ) {
    const doc = editor.getContainerDomNode().ownerDocument;
    this.toolbarNode = doc.createElement('div');
    this.toolbarNode.className = 'selection-widget';
    this.toolbar = new AnchoredWidget(monaco, editor, `vilaus.selectionMenu.${this.id}`, this.toolbarNode);

    this.disposables.add(
      editor.onMouseDown((event) => {
        if (this.isOwnTarget(event.event.browserEvent.target)) {
          return;
        }
        this.hideToolbar();
        this.mouseSelecting = true;
        // The button may come up outside the editor while dragging.
        doc.addEventListener('mouseup', () => {
          this.mouseSelecting = false;
          this.showToolbar();
        }, { once: true, capture: true });
      }),
    );
    this.disposables.add(
      editor.onDidChangeCursorSelection((event) => {
        clearTimeout(this.keyboardTimer);
        if (this.mouseSelecting) {
          return;
        }
        this.hideToolbar();
        if (event.source === 'keyboard') {
          this.keyboardTimer = setTimeout(() => this.showToolbar(), KEYBOARD_DELAY_MS);
        }
      }),
    );
    this.disposables.add(
      editor.onKeyDown((event) => {
        if (event.keyCode === monaco.KeyCode.Escape) {
          if (this.toolbar.visible) {
            // The key closes the menu, not the tab (features/navigation).
            event.preventDefault();
          }
          this.hideToolbar();
        }
      }),
    );
    this.disposables.add(editor.onDidChangeModelContent(() => this.hideToolbar()));
    this.disposables.add(editor.onDidBlurEditorWidget(() => this.hideToolbar()));
    this.disposables.add(toDisposable(() => clearTimeout(this.keyboardTimer)));
  }

  /** The current selection with the context its commands get, for keybindings. */
  context(): EditorSelectionContext | undefined {
    const selection = this.describe();
    return selection ? this.createContext(selection, this.anchor()) : undefined;
  }

  dispose(): void {
    this.hideToolbar();
    for (const widget of [...this.custom]) {
      widget.hide();
    }
    this.custom.clear();
    this.disposables.dispose();
  }

  private isOwnTarget(target: EventTarget | null): boolean {
    const node = target instanceof Node ? target : null;
    return node !== null && (this.toolbarNode.contains(node) || [...this.custom].some((widget) => widget.node.contains(node)));
  }

  /** Where the widgets go: the end the user moved (the cursor). */
  private anchor(): MonacoPosition {
    const position = this.editor.getPosition();
    return position ? { lineNumber: position.lineNumber, column: position.column } : { lineNumber: 1, column: 1 };
  }

  private showToolbar(): void {
    const selection = this.describe();
    if (!selection) {
      this.hideToolbar();
      return;
    }
    const position = this.anchor();
    const toolbar = this.menu.createToolbar(this.toolbarNode.ownerDocument, this.createContext(selection, position));
    if (!toolbar) {
      this.hideToolbar();
      return;
    }
    this.toolbarNode.replaceChildren(toolbar);
    this.toolbar.show(position);
  }

  private hideToolbar(): void {
    this.toolbar.hide();
    this.toolbarNode.replaceChildren();
  }

  private createContext(selection: EditorTextSelection, position: MonacoPosition): EditorSelectionContext {
    return {
      selection,
      showWidget: (element) => {
        this.hideToolbar();
        const node = this.toolbarNode.ownerDocument.createElement('div');
        node.className = 'selection-widget';
        node.appendChild(element);
        // Keys typed in the widget are not editor keys (undo, find...).
        for (const type of ['keydown', 'keyup', 'keypress'] as const) {
          node.addEventListener(type, (event) => event.stopPropagation());
        }
        const widget = new AnchoredWidget(this.monaco, this.editor, `vilaus.selectionWidget.${this.id}.${++widgetCount}`, node);
        this.custom.add(widget);
        widget.show(position);
        // Its content may change size (e.g. a growing text box).
        const observer = new ResizeObserver(() => widget.layout());
        observer.observe(element);
        return toDisposable(() => {
          observer.disconnect();
          widget.hide();
          this.custom.delete(widget);
        });
      },
    };
  }
}
