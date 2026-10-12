/**
 * The editor contribution point: which editor shows a given input in the content pane.
 *
 * An input describes what to show (a text document, a diff, a webview panel, a log...);
 * modules register editors that claim inputs by type, URI scheme or language. The content
 * pane asks the registry for the best editor when it opens a tab.
 */

import type { Event } from '../platform/event';
import type { IDisposable } from '../platform/lifecycle';
import type { RangeDto } from '../platform/protocol';

/** Text the user selected in an editor. */
export interface EditorTextSelection {
  readonly text: string;
  /** The document it is in (`vscode.Uri.toString()`), and the file's path for labels. */
  readonly uri: string;
  readonly path: string;
  /** Where in the document; from a rendered view (Markdown preview), the lines it came from. */
  readonly range: RangeDto;
}

/**
 * What commands of the `editor/selection` menu get (MenuId.EditorSelection): the selection,
 * and a way to show UI of their own next to it.
 */
export interface EditorSelectionContext {
  readonly selection: EditorTextSelection;
  /**
   * Shows `element` next to the selection in place of the menu's buttons, moving with the
   * text; it goes away when disposed, or when the editor closes.
   */
  showWidget(element: HTMLElement): IDisposable;
}

export interface EditorInput {
  /** Identity: opening an input whose id is already open activates that tab. */
  readonly id: string;
  /** What kind of thing it is, e.g. `text`, `diff`, `webview`. */
  readonly typeId: string;
  readonly label: string;
  /** Shown dimmed after the label, e.g. the folder of a file. */
  readonly description?: string;
  readonly tooltip?: string;
  /** For document inputs: the URI (as `vscode.Uri.toString()`) and language. */
  readonly resource?: string;
  readonly languageId?: string;
  /** Whatever the opening module needs to hand to its editor. */
  readonly data?: unknown;
}

/** What the content pane offers an editor for the tab it lives in. */
export interface EditorHost {
  setDirty(dirty: boolean): void;
  /** A preview tab becomes a normal tab (e.g. once it is edited). */
  pin(): void;
  close(): void;
  /** The editor took focus; the pane makes its tab the active one. */
  activate(): void;
}

export interface EditorPane extends IDisposable {
  /** The tab became the visible one, or the pane was resized. */
  layout(): void;
  setVisible(visible: boolean): void;
  focus(): void;
  /** Returns false to keep the tab open (e.g. the user cancelled saving changes). */
  confirmClose?(): Promise<boolean>;
  /**
   * False keeps the tab open on an Escape nothing in it took (which closes a tab looked at,
   * features/navigation): a pane where closing decides something, or loses what was typed.
   */
  readonly closesOnEscape?: boolean;
  /**
   * Shows the same editor in another container, possibly in another window's document (a
   * tab moved into its own window and back). Editors without it cannot be moved.
   */
  relocate?(container: HTMLElement): void;
  /** Ids of the text editors this pane shows, the input-taking one first (for `visibleTextEditors`). */
  readonly textEditorIds?: readonly string[];
  readonly onDidChangeTextEditors?: Event<void>;
  /**
   * The text selected in this pane now, for `editor/selection` commands run from a
   * keybinding; undefined when nothing is selected. Panes with it show the menu by selections.
   */
  selectionContext?(): EditorSelectionContext | undefined;
  /**
   * Selects `range` of document `uri` if this pane shows it, and scrolls it into view.
   * `text` is what was selected there, for views without lines (a rendered preview).
   * Returns false when the pane does not show that document.
   */
  revealSelection?(uri: string, range: RangeDto, text: string): boolean;
}

export interface EditorProvider {
  readonly id: string;
  /** Among the providers that accept an input, the highest priority wins (default 0). */
  readonly priority?: number;
  accepts(input: EditorInput): boolean;
  create(container: HTMLElement, input: EditorInput, host: EditorHost): EditorPane;
}

export class EditorRegistry {
  private readonly providers: EditorProvider[] = [];

  register(provider: EditorProvider): IDisposable {
    this.providers.push(provider);
    return {
      dispose: () => {
        const index = this.providers.indexOf(provider);
        if (index >= 0) {
          this.providers.splice(index, 1);
        }
      },
    };
  }

  resolve(input: EditorInput): EditorProvider | undefined {
    let best: EditorProvider | undefined;
    for (const provider of this.providers) {
      if (provider.accepts(input) && (!best || (provider.priority ?? 0) > (best.priority ?? 0))) {
        best = provider;
      }
    }
    return best;
  }
}
