/**
 * A content pane tab with a Monaco code editor on one document. Reports its selections to
 * the extension host (the extension's "N lines selected" comes from them), and follows the
 * extension's selection and reveal requests.
 */

import { Emitter } from '../../platform/event';
import { DisposableStore } from '../../platform/lifecycle';
import type { DocumentSnapshot, RangeDto, RevealType, SelectionDto } from '../../platform/protocol';
import type { EditorHost, EditorPane, EditorSelectionContext } from '../../core/editors';
import type { ExtensionHostConnection } from '../../core/extensionHost';
import type { Dialogs } from '../../core/dialogs';
import { t } from './messages';
import type { MonacoApi } from './monaco';
import { MonacoSelectionWidget, monacoSelection, type SelectionMenu } from './selectionMenu';
import { toMonacoRange, type ModelReference, type TextModels } from './textModels';

type CodeEditor = ReturnType<MonacoApi['editor']['create']>;

export interface TextInputData {
  readonly tabId: string;
  readonly editorId: string;
  readonly document: DocumentSnapshot;
}

export function editorFontOptions(): { fontFamily: string; fontSize: number; fontWeight: string } {
  const style = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(style.getPropertyValue('--vscode-editor-font-size'));
  return {
    fontFamily: style.getPropertyValue('--vscode-editor-font-family').trim() || 'Consolas, "Courier New", monospace',
    fontSize: Number.isFinite(size) && size > 0 ? size : 14,
    fontWeight: style.getPropertyValue('--vscode-editor-font-weight').trim() || 'normal',
  };
}

export function selectionToDto(selection: {
  selectionStartLineNumber: number;
  selectionStartColumn: number;
  positionLineNumber: number;
  positionColumn: number;
}): SelectionDto {
  return {
    anchor: { line: selection.selectionStartLineNumber - 1, character: selection.selectionStartColumn - 1 },
    active: { line: selection.positionLineNumber - 1, character: selection.positionColumn - 1 },
  };
}

export class TextEditorPane implements EditorPane {
  editor: CodeEditor;
  private readonly model: ModelReference;
  private readonly disposables = new DisposableStore();
  /** What belongs to the current Monaco widget; recreated when the pane moves. */
  private readonly editorDisposables = new DisposableStore();
  private banner: HTMLElement;
  private body: HTMLElement;
  private selectionWidget: MonacoSelectionWidget | undefined;
  private readonly textEditorsEmitter = new Emitter<void>();
  readonly onDidChangeTextEditors = this.textEditorsEmitter.event;

  constructor(
    private readonly monaco: MonacoApi,
    container: HTMLElement,
    private readonly data: TextInputData,
    private readonly host: EditorHost,
    private readonly models: TextModels,
    private readonly connection: ExtensionHostConnection,
    private readonly dialogs: Dialogs,
    private readonly label: string,
    /** Monaco options from the settings and the theme's fonts; asked again when the pane moves. */
    private readonly options: () => Record<string, unknown>,
    private readonly selectionMenu: SelectionMenu,
  ) {
    this.model = models.acquire(data.document);
    const entry = this.model.entry;
    [this.banner, this.body] = this.createLayout(container);
    this.editor = this.createEditor();
    host.setDirty(entry.isDirty);
    this.disposables.add(entry.onDidChangeDirty((dirty) => host.setDirty(dirty)));
    this.disposables.add(entry.onDidConflict(() => this.showConflict()));
    this.disposables.add(this.editorDisposables);
  }

  /** A new Monaco widget in `container` (e.g. another window's), same model, same view state. */
  relocate(container: HTMLElement): void {
    const viewState = this.editor.saveViewState();
    const conflictShown = !this.banner.hidden;
    this.editorDisposables.clear();
    this.editor.dispose();
    this.banner.remove();
    this.body.remove();
    [this.banner, this.body] = this.createLayout(container);
    this.editor = this.createEditor();
    if (viewState) {
      this.editor.restoreViewState(viewState);
    }
    if (conflictShown) {
      this.showConflict();
    }
  }

  private createLayout(container: HTMLElement): [HTMLElement, HTMLElement] {
    const doc = container.ownerDocument;
    container.classList.add('text-editor-container');
    const banner = doc.createElement('div');
    banner.className = 'editor-banner';
    banner.hidden = true;
    const body = doc.createElement('div');
    body.className = 'editor-body';
    container.append(banner, body);
    return [banner, body];
  }

  private createEditor(): CodeEditor {
    const entry = this.model.entry;
    const editor = this.monaco.editor.create(this.body, {
      ...this.options(),
      model: entry.model,
      readOnly: entry.readOnly,
      automaticLayout: true,
      fixedOverflowWidgets: true,
    });
    this.editorDisposables.add(
      editor.onDidChangeCursorSelection(() => {
        this.connection.rpc?.notify('editor.didChangeSelection', {
          editorId: this.data.editorId,
          selections: (editor.getSelections() ?? []).map(selectionToDto),
        });
      }),
    );
    // (A preview tab is kept once it has unsaved changes: the content pane pins dirty tabs.)
    this.editorDisposables.add(editor.onDidFocusEditorText(() => this.host.activate()));
    this.selectionWidget = this.editorDisposables.add(
      new MonacoSelectionWidget(this.monaco, editor, this.selectionMenu, () => monacoSelection(editor, this.data.document)),
    );
    return editor;
  }

  selectionContext(): EditorSelectionContext | undefined {
    return this.selectionWidget?.context();
  }

  revealSelection(uri: string, range: RangeDto): boolean {
    if (uri !== this.uri) {
      return false;
    }
    this.setSelections([{ anchor: range.start, active: range.end }]);
    this.revealRange(range, 'centerIfOutside');
    this.focus();
    return true;
  }

  get textEditorIds(): readonly string[] {
    return [this.data.editorId];
  }

  get uri(): string {
    return this.data.document.uri;
  }

  get documentUri(): string {
    return this.uri;
  }

  layout(): void {
    this.editor.layout();
  }

  setVisible(): void {}

  focus(): void {
    this.editor.focus();
  }

  setSelections(selections: readonly SelectionDto[]): void {
    if (selections.length === 0) {
      return;
    }
    this.editor.setSelections(
      selections.map((s) => ({
        selectionStartLineNumber: s.anchor.line + 1,
        selectionStartColumn: s.anchor.character + 1,
        positionLineNumber: s.active.line + 1,
        positionColumn: s.active.character + 1,
      })),
    );
  }

  revealRange(range: RangeDto, revealType: RevealType): void {
    const target = toMonacoRange(range);
    switch (revealType) {
      case 'center':
        this.editor.revealRangeInCenter(target);
        break;
      case 'centerIfOutside':
        this.editor.revealRangeInCenterIfOutsideViewport(target);
        break;
      case 'top':
        this.editor.revealRangeAtTop(target);
        break;
      default:
        this.editor.revealRange(target);
    }
  }

  async confirmClose(): Promise<boolean> {
    const entry = this.model.entry;
    // Another tab still shows the document: its changes stay there.
    if (!entry.isDirty || this.models.get(entry.uri) !== entry || this.sharedElsewhere()) {
      return true;
    }
    const choice = await this.dialogs.showMessage({
      severity: 'warning',
      message: t('saveChangesQuestion', this.label),
      detail: t('saveChangesDetail'),
      modal: true,
      items: [t('save'), t('dontSave')],
    });
    if (choice === 0) {
      return this.models.save(entry.uri);
    }
    return choice === 1;
  }

  dispose(): void {
    this.disposables.dispose();
    this.textEditorsEmitter.dispose();
    this.editor.dispose();
    this.model.dispose();
    this.connection.rpc?.notify('tab.didClose', { tabId: this.data.tabId });
  }

  private sharedElsewhere(): boolean {
    return this.monaco.editor.getEditors().some((other) => other !== this.editor && other.getModel() === this.model.entry.model);
  }

  private showConflict(): void {
    const doc = this.banner.ownerDocument;
    const message = doc.createElement('span');
    message.className = 'editor-banner-message';
    message.textContent = t('changedOnDisk');
    const reload = doc.createElement('button');
    reload.className = 'button';
    reload.textContent = t('reload');
    reload.addEventListener('click', () => {
      this.banner.hidden = true;
      void this.models.revert(this.uri);
    });
    const keep = doc.createElement('button');
    keep.className = 'button secondary';
    keep.textContent = t('keepMine');
    keep.addEventListener('click', () => {
      this.banner.hidden = true;
    });
    this.banner.replaceChildren(message, reload, keep);
    this.banner.hidden = false;
    this.host.pin();
  }
}
