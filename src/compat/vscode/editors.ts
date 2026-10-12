/**
 * Text editors and the content pane's text and diff tabs: what `window.activeTextEditor`,
 * `visibleTextEditors`, `showTextDocument` and the `vscode.diff` command see. The renderer
 * draws the editors; this side keeps the state the extension reads and the ids both sides
 * use to talk about them.
 */

import type * as vscode from 'vscode';
import { Emitter, type Event } from '../../platform/event';
import { generateId } from '../../platform/ids';
import type { ILogger } from '../../platform/log';
import type { DiffActionDto, RangeDto, RevealType, SelectionDto } from '../../platform/protocol';
import type { EditorsBackend } from './host';
import type { TabGroupsModel, TabImpl } from './tabs';
import type { TextDocumentImpl, TextDocuments } from './textDocuments';
import {
  Position,
  Range,
  Selection,
  TabInputText,
  TabInputTextDiff,
  TextEditorLineNumbersStyle,
  TextEditorRevealType,
  TextEditorSelectionChangeKind,
  ViewColumn,
} from './types';
import type { Uri } from './uri';

/**
 * anthropic.claude-code 2.1.282 keeps a proposed edit in a document of this scheme and
 * offers these commands in the diff editor's title bar (`editor/title`, enabled while
 * such a document is visible). They act on the active tab.
 */
const PROPOSED_EDIT_SCHEME = '_claude_vscode_fs_right';
const PROPOSED_EDIT_ACTIONS: readonly DiffActionDto[] = [
  { command: 'claude-vscode.acceptProposedDiff', kind: 'accept' },
  { command: 'claude-vscode.rejectProposedDiff', kind: 'reject' },
];

export function toRangeDto(range: vscode.Range): RangeDto {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function toSelectionDto(selection: vscode.Selection): SelectionDto {
  return {
    anchor: { line: selection.anchor.line, character: selection.anchor.character },
    active: { line: selection.active.line, character: selection.active.character },
  };
}

function fromSelectionDto(dto: SelectionDto): Selection {
  return new Selection(dto.anchor.line, dto.anchor.character, dto.active.line, dto.active.character);
}

function revealTypeName(type: vscode.TextEditorRevealType | undefined): RevealType {
  switch (type as number | undefined) {
    case TextEditorRevealType.InCenter:
      return 'center';
    case TextEditorRevealType.InCenterIfOutsideViewport:
      return 'centerIfOutside';
    case TextEditorRevealType.AtTop:
      return 'top';
    default:
      return 'default';
  }
}

/** Collects `TextEditor.edit` callbacks into plain edits. */
class EditBuilder {
  readonly edits: { range: vscode.Range; newText: string }[] = [];

  replace(location: vscode.Position | vscode.Range | vscode.Selection, value: string): void {
    const range = location instanceof Position ? new Range(location, location) : (location as vscode.Range);
    this.edits.push({ range, newText: value });
  }

  insert(location: vscode.Position, value: string): void {
    this.edits.push({ range: new Range(location, location), newText: value });
  }

  delete(location: vscode.Range | vscode.Selection): void {
    this.edits.push({ range: location, newText: '' });
  }

  setEndOfLine(): void {}
}

export class TextEditorImpl {
  private selectionsValue: readonly Selection[] = [new Selection(0, 0, 0, 0)];
  readonly options: vscode.TextEditorOptions = {
    tabSize: 4,
    indentSize: 4,
    insertSpaces: true,
    cursorStyle: 1,
    lineNumbers: TextEditorLineNumbersStyle.On as unknown as vscode.TextEditorLineNumbersStyle,
  };
  readonly visibleRanges: readonly vscode.Range[] = [];
  readonly viewColumn = ViewColumn.Two;

  constructor(
    readonly id: string,
    readonly document: TextDocumentImpl,
    private readonly backend: EditorsBackend,
    private readonly documents: TextDocuments,
  ) {}

  get selection(): Selection {
    return this.selectionsValue[0]!;
  }

  set selection(value: vscode.Selection) {
    this.selections = [value];
  }

  get selections(): readonly Selection[] {
    return this.selectionsValue;
  }

  set selections(value: readonly vscode.Selection[]) {
    if (value.length === 0) {
      throw new Error('TextEditor.selections must not be empty');
    }
    this.selectionsValue = value.map((s) => new Selection(s.anchor, s.active));
    this.backend.setSelections(this.id, this.selectionsValue.map(toSelectionDto));
  }

  /** The renderer reported new selections. */
  acceptSelections(selections: readonly SelectionDto[]): void {
    if (selections.length > 0) {
      this.selectionsValue = selections.map(fromSelectionDto);
    }
  }

  revealRange(range: vscode.Range, revealType?: vscode.TextEditorRevealType): void {
    this.backend.revealRange(this.id, toRangeDto(range), revealTypeName(revealType));
  }

  async edit(callback: (builder: vscode.TextEditorEdit) => void): Promise<boolean> {
    const builder = new EditBuilder();
    callback(builder as unknown as vscode.TextEditorEdit);
    if (builder.edits.length === 0) {
      return true;
    }
    return this.documents.applyTextEdits(this.document.uri, builder.edits);
  }

  async insertSnippet(snippet: vscode.SnippetString, location?: vscode.Position | vscode.Range): Promise<boolean> {
    // No snippet engine: insert the snippet's text with its placeholders' defaults.
    const text = snippet.value.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{?\d+\}?/g, '');
    const range = location ? (location instanceof Position ? new Range(location, location) : location) : this.selection;
    return this.documents.applyTextEdits(this.document.uri, [{ range: range as vscode.Range, newText: text }]);
  }

  setDecorations(): void {}

  show(): void {}

  hide(): void {}
}

interface TextTab {
  readonly tab: TabImpl;
  readonly editor: TextEditorImpl;
}

interface DiffTab {
  readonly tab: TabImpl;
  readonly original: TextEditorImpl;
  readonly modified: TextEditorImpl;
}

export class EditorService {
  /** Text tabs by document URI: showing a document again activates its tab. */
  private readonly textTabs = new Map<string, TextTab>();
  private readonly diffTabs = new Map<string, DiffTab>();
  private readonly tabIds = new Map<TabImpl, string>();
  private readonly editors = new Map<string, TextEditorImpl>();
  private activeEditor: TextEditorImpl | undefined;
  private visible: readonly TextEditorImpl[] = [];
  private readonly activeEmitter = new Emitter<vscode.TextEditor | undefined>();
  private readonly visibleEmitter = new Emitter<readonly vscode.TextEditor[]>();
  private readonly selectionEmitter = new Emitter<vscode.TextEditorSelectionChangeEvent>();
  readonly onDidChangeActiveTextEditor: Event<vscode.TextEditor | undefined> = this.activeEmitter.event;
  readonly onDidChangeVisibleTextEditors: Event<readonly vscode.TextEditor[]> = this.visibleEmitter.event;
  readonly onDidChangeTextEditorSelection: Event<vscode.TextEditorSelectionChangeEvent> = this.selectionEmitter.event;

  constructor(
    private readonly backend: EditorsBackend,
    private readonly tabs: TabGroupsModel,
    private readonly documents: TextDocuments,
    private readonly logger: ILogger,
  ) {
    backend.onDidChangeSelection(({ editorId, selections }) => {
      const editor = this.editors.get(editorId);
      if (!editor) {
        return;
      }
      editor.acceptSelections(selections);
      this.selectionEmitter.fire({
        textEditor: editor as unknown as vscode.TextEditor,
        selections: editor.selections,
        kind: TextEditorSelectionChangeKind.Mouse as unknown as vscode.TextEditorSelectionChangeKind,
      });
    });
    backend.onDidChangeVisible(({ active, visible }) => this.acceptVisible(active, visible));
    backend.onDidActivateTab(({ tabId }) => {
      const tab = this.tabById(tabId);
      if (tab) {
        this.tabs.setActive(tab);
      }
    });
    backend.onDidCloseTab(({ tabId }) => this.forget(tabId));
  }

  get activeTextEditor(): TextEditorImpl | undefined {
    return this.activeEditor;
  }

  get visibleTextEditors(): readonly TextEditorImpl[] {
    return this.visible;
  }

  /** `window.showTextDocument`: opens or activates the document's text tab. */
  async showTextDocument(document: TextDocumentImpl, options: vscode.TextDocumentShowOptions = {}): Promise<TextEditorImpl> {
    const key = document.uri.toString();
    let entry = this.textTabs.get(key);
    if (!entry) {
      const newTabId = generateId('tab');
      const editor = new TextEditorImpl(generateId('editor'), document, this.backend, this.documents);
      const tab = this.tabs.add('side', basename(document.uri), new TabInputText(document.uri as Uri), () =>
        this.closeFromExtension(newTabId),
      );
      entry = { tab, editor };
      this.textTabs.set(key, entry);
      this.tabIds.set(tab, newTabId);
      this.editors.set(editor.id, editor);
      this.documents.attach(document);
    }
    const tabId = this.tabIds.get(entry.tab)!;
    if (options.selection) {
      entry.editor.acceptSelections([toSelectionDto(new Selection(options.selection.start, options.selection.end))]);
    }
    await this.backend.showText({
      tabId,
      editorId: entry.editor.id,
      document: document.snapshot(this.documents.isReadOnly(document)),
      preserveFocus: options.preserveFocus === true,
      preview: options.preview !== false,
      selection: options.selection ? toRangeDto(options.selection) : undefined,
    });
    this.tabs.setActive(entry.tab);
    return entry.editor;
  }

  /**
   * The `vscode.diff` command: a diff tab whose right side is editable when its document is.
   * The tab enters `tabGroups` before this resolves; the extension polls for it right after.
   */
  async openDiff(
    left: TextDocumentImpl,
    right: TextDocumentImpl,
    title: string,
    options: vscode.TextDocumentShowOptions = {},
  ): Promise<void> {
    // VS Code reuses an open diff of the same pair; the extension closes such tabs itself
    // first, but stay safe: one tab per pair.
    for (const [tabId, existing] of [...this.diffTabs]) {
      if (existing.original.document === left && existing.modified.document === right) {
        this.closeFromExtension(tabId);
      }
    }
    const tabId = generateId('tab');
    const original = new TextEditorImpl(generateId('editor'), left, this.backend, this.documents);
    const modified = new TextEditorImpl(generateId('editor'), right, this.backend, this.documents);
    const tab = this.tabs.add('side', title, new TabInputTextDiff(left.uri as Uri, right.uri as Uri), () => this.closeFromExtension(tabId));
    this.diffTabs.set(tabId, { tab, original, modified });
    this.tabIds.set(tab, tabId);
    this.editors.set(original.id, original);
    this.editors.set(modified.id, modified);
    this.documents.attach(left);
    this.documents.attach(right);
    this.tabs.setActive(tab);
    await this.backend.showDiff({
      tabId,
      title,
      original: left.snapshot(true),
      modified: right.snapshot(this.documents.isReadOnly(right)),
      originalEditorId: original.id,
      modifiedEditorId: modified.id,
      preserveFocus: options.preserveFocus === true,
      actions: right.uri.scheme === PROPOSED_EDIT_SCHEME ? PROPOSED_EDIT_ACTIONS : [],
    });
  }

  private tabById(tabId: string): TabImpl | undefined {
    return this.diffTabs.get(tabId)?.tab ?? [...this.textTabs.values()].find((entry) => this.tabIds.get(entry.tab) === tabId)?.tab;
  }

  /** `tabGroups.close(tab)` from the extension: close it in the shell too. */
  private closeFromExtension(tabId: string): void {
    if (this.forget(tabId)) {
      this.backend.closeTab(tabId);
    }
  }

  /** Drops a text or diff tab and its editors. Returns false when the tab is unknown. */
  private forget(tabId: string): boolean {
    const diff = this.diffTabs.get(tabId);
    if (diff) {
      this.diffTabs.delete(tabId);
      this.dropTab(diff.tab, [diff.original, diff.modified]);
      return true;
    }
    for (const [key, entry] of this.textTabs) {
      if (this.tabIds.get(entry.tab) === tabId) {
        this.textTabs.delete(key);
        this.dropTab(entry.tab, [entry.editor]);
        return true;
      }
    }
    return false;
  }

  private dropTab(tab: TabImpl, editors: readonly TextEditorImpl[]): void {
    this.tabIds.delete(tab);
    this.tabs.remove(tab);
    for (const editor of editors) {
      this.editors.delete(editor.id);
    }
    const remaining = this.visible.filter((editor) => !editors.includes(editor));
    if (remaining.length !== this.visible.length || (this.activeEditor && editors.includes(this.activeEditor))) {
      this.applyVisible(this.activeEditor && editors.includes(this.activeEditor) ? undefined : this.activeEditor, remaining);
    }
    // Detach after the editors are gone, so a closed document is never reported as visible.
    for (const editor of editors) {
      this.documents.detach(editor.document);
    }
  }

  private acceptVisible(activeId: string | undefined, visibleIds: readonly string[]): void {
    const visible = visibleIds.flatMap((id) => {
      const editor = this.editors.get(id);
      return editor ? [editor] : [];
    });
    const active = activeId ? this.editors.get(activeId) : undefined;
    this.applyVisible(active, visible);
  }

  private applyVisible(active: TextEditorImpl | undefined, visible: readonly TextEditorImpl[]): void {
    const visibleChanged = visible.length !== this.visible.length || visible.some((editor, i) => editor !== this.visible[i]);
    const activeChanged = active !== this.activeEditor;
    this.visible = visible;
    this.activeEditor = active;
    // VS Code fires visible before active; the extension's selection tracking reads both.
    if (visibleChanged) {
      this.visibleEmitter.fire(visible as unknown as readonly vscode.TextEditor[]);
    }
    if (activeChanged) {
      this.logger.debug(`active text editor: ${active?.document.fileName ?? 'none'}`);
      this.activeEmitter.fire(active as unknown as vscode.TextEditor | undefined);
    }
  }
}

function basename(uri: vscode.Uri): string {
  const path = uri.path;
  return path.slice(path.lastIndexOf('/') + 1) || path;
}
