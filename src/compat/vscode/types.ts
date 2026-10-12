// Value types and enums for the `vscode` API compatibility layer used by vilaus.
// Enum values are verified against @types/vscode 1.140; class behavior mirrors VS Code's
// extHostTypes.ts so that `new Position(...)` and `instanceof` checks behave identically.

import type * as vscode from 'vscode';
import { Uri } from './uri';

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3,
}

export enum FilePermission {
  Readonly = 1,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export enum UIKind {
  Desktop = 1,
  Web = 2,
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export enum ExtensionKind {
  UI = 1,
  Workspace = 2,
}

export enum TextDocumentChangeReason {
  Undo = 1,
  Redo = 2,
}

export enum TextDocumentSaveReason {
  Manual = 1,
  AfterDelay = 2,
  FocusOut = 3,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

export enum TextEditorSelectionChangeKind {
  Keyboard = 1,
  Mouse = 2,
  Command = 3,
}

export enum TextEditorLineNumbersStyle {
  Off = 0,
  On = 1,
  Relative = 2,
  Interval = 3,
}

export enum DecorationRangeBehavior {
  OpenOpen = 0,
  ClosedClosed = 1,
  OpenClosed = 2,
  ClosedOpen = 3,
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

export enum CommentThreadCollapsibleState {
  Collapsed = 0,
  Expanded = 1,
}

export enum CommentThreadState {
  Unresolved = 0,
  Resolved = 1,
}

export enum CommentMode {
  Editing = 0,
  Preview = 1,
}

export enum NotebookCellKind {
  Markup = 1,
  Code = 2,
}

export enum NotebookEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export enum TerminalLocation {
  Panel = 1,
  Editor = 2,
}

export enum TerminalExitReason {
  Unknown = 0,
  Shutdown = 1,
  Process = 2,
  User = 3,
  Extension = 4,
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

export enum LogLevel {
  Off = 0,
  Trace = 1,
  Debug = 2,
  Info = 3,
  Warning = 4,
  Error = 5,
}

export enum EnvironmentVariableMutatorType {
  Replace = 1,
  Append = 2,
  Prepend = 3,
}

interface PositionLike {
  readonly line: number;
  readonly character: number;
}

interface RangeLike {
  readonly start: PositionLike;
  readonly end: PositionLike;
}

function isPositionLike(value: unknown): value is PositionLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PositionLike).line === 'number' &&
    typeof (value as PositionLike).character === 'number'
  );
}

function isRangeLike(value: unknown): value is RangeLike {
  return (
    typeof value === 'object' && value !== null && isPositionLike((value as RangeLike).start) && isPositionLike((value as RangeLike).end)
  );
}

export class Position implements vscode.Position {
  /** Like VS Code: instances pass through, plain `{ line, character }` objects are converted. */
  static of(value: PositionLike): Position {
    return value instanceof Position ? value : new Position(value.line, value.character);
  }

  readonly line: number;
  readonly character: number;

  constructor(line: number, character: number) {
    if (line < 0) {
      throw new Error('line must be non-negative');
    }
    if (character < 0) {
      throw new Error('character must be non-negative');
    }
    this.line = line;
    this.character = character;
  }

  isBefore(other: PositionLike): boolean {
    if (this.line < other.line) {
      return true;
    }
    if (other.line < this.line) {
      return false;
    }
    return this.character < other.character;
  }

  isBeforeOrEqual(other: PositionLike): boolean {
    if (this.line < other.line) {
      return true;
    }
    if (other.line < this.line) {
      return false;
    }
    return this.character <= other.character;
  }

  isAfter(other: PositionLike): boolean {
    return !this.isBeforeOrEqual(other);
  }

  isAfterOrEqual(other: PositionLike): boolean {
    return !this.isBefore(other);
  }

  isEqual(other: PositionLike): boolean {
    return this.line === other.line && this.character === other.character;
  }

  compareTo(other: PositionLike): number {
    if (this.line < other.line) {
      return -1;
    }
    if (this.line > other.line) {
      return 1;
    }
    if (this.character < other.character) {
      return -1;
    }
    if (this.character > other.character) {
      return 1;
    }
    return 0;
  }

  translate(lineDelta?: number, characterDelta?: number): Position;
  translate(change: { lineDelta?: number; characterDelta?: number }): Position;
  translate(lineDeltaOrChange?: number | { lineDelta?: number; characterDelta?: number }, characterDelta: number = 0): Position {
    let lineDelta: number;
    if (typeof lineDeltaOrChange === 'undefined') {
      lineDelta = 0;
    } else if (typeof lineDeltaOrChange === 'number') {
      lineDelta = lineDeltaOrChange;
    } else {
      lineDelta = typeof lineDeltaOrChange.lineDelta === 'number' ? lineDeltaOrChange.lineDelta : 0;
      characterDelta = typeof lineDeltaOrChange.characterDelta === 'number' ? lineDeltaOrChange.characterDelta : 0;
    }
    if (lineDelta === 0 && characterDelta === 0) {
      return this;
    }
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }

  with(line?: number, character?: number): Position;
  with(change: { line?: number; character?: number }): Position;
  with(lineOrChange?: number | { line?: number; character?: number }, character: number = this.character): Position {
    let line: number;
    if (typeof lineOrChange === 'undefined') {
      line = this.line;
    } else if (typeof lineOrChange === 'number') {
      line = lineOrChange;
    } else {
      line = typeof lineOrChange.line === 'number' ? lineOrChange.line : this.line;
      character = typeof lineOrChange.character === 'number' ? lineOrChange.character : this.character;
    }
    if (line === this.line && character === this.character) {
      return this;
    }
    return new Position(line, character);
  }
}

export class Range implements vscode.Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: PositionLike, end: PositionLike);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(
    startLineOrStart: number | PositionLike,
    startCharacterOrEnd: number | PositionLike,
    endLine?: number,
    endCharacter?: number,
  ) {
    let start: Position;
    let end: Position;
    if (
      typeof startLineOrStart === 'number' &&
      typeof startCharacterOrEnd === 'number' &&
      typeof endLine === 'number' &&
      typeof endCharacter === 'number'
    ) {
      start = new Position(startLineOrStart, startCharacterOrEnd);
      end = new Position(endLine, endCharacter);
    } else if (isPositionLike(startLineOrStart) && isPositionLike(startCharacterOrEnd)) {
      start = Position.of(startLineOrStart);
      end = Position.of(startCharacterOrEnd);
    } else {
      throw new Error('Invalid arguments');
    }

    // Swap when start is not before end so start <= end always holds.
    if (start.isBefore(end)) {
      this.start = start;
      this.end = end;
    } else {
      this.start = end;
      this.end = start;
    }
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: PositionLike | RangeLike): boolean {
    if (isRangeLike(positionOrRange)) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
    if (isPositionLike(positionOrRange)) {
      if (Position.of(positionOrRange).isBefore(this.start)) {
        return false;
      }
      if (this.end.isBefore(positionOrRange)) {
        return false;
      }
      return true;
    }
    return false;
  }

  isEqual(other: RangeLike): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(range: RangeLike): Range | undefined {
    const otherStart = Position.of(range.start);
    const otherEnd = Position.of(range.end);
    const start = this.start.isAfter(otherStart) ? this.start : otherStart;
    const end = this.end.isBefore(otherEnd) ? this.end : otherEnd;
    if (start.isAfter(end)) {
      return undefined;
    }
    return new Range(start, end);
  }

  union(other: RangeLike): Range {
    const otherRange = other instanceof Range ? other : new Range(other.start, other.end);
    if (this.contains(otherRange)) {
      return this;
    }
    if (otherRange.contains(this)) {
      return otherRange;
    }
    const start = this.start.isBefore(otherRange.start) ? this.start : otherRange.start;
    const end = this.end.isAfter(otherRange.end) ? this.end : otherRange.end;
    return new Range(start, end);
  }

  with(start?: PositionLike, end?: PositionLike): Range;
  with(change: { start?: PositionLike; end?: PositionLike }): Range;
  with(startOrChange?: PositionLike | { start?: PositionLike; end?: PositionLike }, end: PositionLike = this.end): Range {
    let start: PositionLike;
    if (!startOrChange) {
      start = this.start;
    } else if (isPositionLike(startOrChange)) {
      start = startOrChange;
    } else {
      start = startOrChange.start ?? this.start;
      end = startOrChange.end ?? this.end;
    }
    if (this.start.isEqual(start) && this.end.isEqual(end)) {
      return this;
    }
    return new Range(start, end);
  }
}

export class Selection extends Range implements vscode.Selection {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchor: PositionLike, active: PositionLike);
  constructor(anchorLine: number, anchorCharacter: number, activeLine: number, activeCharacter: number);
  constructor(
    anchorLineOrAnchor: number | PositionLike,
    anchorCharacterOrActive: number | PositionLike,
    activeLine?: number,
    activeCharacter?: number,
  ) {
    let anchor: Position;
    let active: Position;
    if (
      typeof anchorLineOrAnchor === 'number' &&
      typeof anchorCharacterOrActive === 'number' &&
      typeof activeLine === 'number' &&
      typeof activeCharacter === 'number'
    ) {
      anchor = new Position(anchorLineOrAnchor, anchorCharacterOrActive);
      active = new Position(activeLine, activeCharacter);
    } else if (isPositionLike(anchorLineOrAnchor) && isPositionLike(anchorCharacterOrActive)) {
      anchor = Position.of(anchorLineOrAnchor);
      active = Position.of(anchorCharacterOrActive);
    } else {
      throw new Error('Invalid arguments');
    }

    super(anchor, active);

    this.anchor = anchor;
    this.active = active;
  }

  /** Reversed when the anchor is the end. Identity check, as in VS Code: Range keeps our instances. */
  get isReversed(): boolean {
    return this.anchor === this.end;
  }
}

export class Location implements vscode.Location {
  uri: Uri;
  range: Range;

  constructor(uri: Uri, rangeOrPosition: Range | Position) {
    this.uri = uri;
    this.range = rangeOrPosition instanceof Range ? rangeOrPosition : new Range(rangeOrPosition, rangeOrPosition);
  }
}

export class Disposable implements vscode.Disposable {
  static from(...disposableLikes: { dispose: () => unknown }[]): Disposable {
    return new Disposable(() => {
      for (const disposable of disposableLikes) {
        if (disposable && typeof disposable.dispose === 'function') {
          disposable.dispose();
        }
      }
    });
  }

  private callOnDispose: (() => unknown) | undefined;

  constructor(callOnDispose: () => unknown) {
    this.callOnDispose = callOnDispose;
  }

  dispose(): void {
    if (typeof this.callOnDispose === 'function') {
      const fn = this.callOnDispose;
      this.callOnDispose = undefined;
      fn();
    }
  }
}

export class ThemeColor implements vscode.ThemeColor {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }
}

export class ThemeIcon implements vscode.ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');

  readonly id: string;
  readonly color?: ThemeColor;

  constructor(id: string, color?: ThemeColor) {
    this.id = id;
    this.color = color;
  }
}

function escapeMarkdownSyntaxTokens(text: string): string {
  // Same character set as VS Code's escapeMarkdownSyntaxTokens.
  return text.replace(/[\\`*_{}[\]()#+\-!~]/g, '\\$&');
}

export class MarkdownString implements vscode.MarkdownString {
  value: string;
  isTrusted?: boolean | { readonly enabledCommands: readonly string[] };
  supportThemeIcons?: boolean;
  supportHtml?: boolean;
  baseUri?: Uri;

  constructor(value?: string, supportThemeIcons: boolean = false) {
    this.value = value ?? '';
    this.supportThemeIcons = supportThemeIcons;
  }

  appendText(value: string): MarkdownString {
    this.value += escapeMarkdownSyntaxTokens(value);
    return this;
  }

  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendCodeblock(value: string, language: string = ''): MarkdownString {
    this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`;
    return this;
  }
}

/**
 * VS Code's FileSystemProviderErrorCode for each factory. VS Code puts it in `error.name`
 * (`EntryNotFound (FileSystemError)`) and the factory's name in `error.code` (`FileNotFound`);
 * checked against VSCodium 1.121's extensionHostProcess.js.
 */
const PROVIDER_ERROR_CODES: Readonly<Record<string, string>> = {
  FileExists: 'EntryExists',
  FileNotFound: 'EntryNotFound',
  FileNotADirectory: 'EntryNotADirectory',
  FileIsADirectory: 'EntryIsADirectory',
  NoPermissions: 'NoPermissions',
  Unavailable: 'Unavailable',
};

export class FileSystemError extends Error implements vscode.FileSystemError {
  static FileNotFound(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'FileNotFound');
  }

  static FileExists(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'FileExists');
  }

  static FileNotADirectory(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'FileNotADirectory');
  }

  static FileIsADirectory(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'FileIsADirectory');
  }

  static NoPermissions(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'NoPermissions');
  }

  static Unavailable(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, 'Unavailable');
  }

  /** The factory's name, e.g. `FileNotFound`; `Unknown` when constructed directly. */
  readonly code: string;

  constructor(messageOrUri?: string | Uri, code: string = 'Unknown') {
    super(typeof messageOrUri === 'string' ? messageOrUri : messageOrUri?.toString(true));
    this.code = code;
    this.name = `${PROVIDER_ERROR_CODES[code] ?? 'Unknown'} (FileSystemError)`;
    // Fix `instanceof` / prototype chain when subclassing the built-in Error.
    Object.setPrototypeOf(this, FileSystemError.prototype);
  }
}

// Not `implements vscode.TextEdit`: `newEol` uses this module's `EndOfLine` enum, which is
// nominally incompatible with `vscode.EndOfLine`.
export class TextEdit {
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }

  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }

  static delete(range: Range): TextEdit {
    return new TextEdit(range, '');
  }

  static setEndOfLine(eol: EndOfLine): TextEdit {
    const edit = new TextEdit(new Range(new Position(0, 0), new Position(0, 0)), '');
    edit.newEol = eol;
    return edit;
  }

  range: Range;
  newText: string;
  newEol?: EndOfLine;

  constructor(range: Range, newText: string) {
    this.range = range;
    this.newText = newText;
  }
}

type FileOperation =
  | { readonly kind: 'create'; readonly uri: Uri; readonly options: unknown }
  | { readonly kind: 'delete'; readonly uri: Uri; readonly options: unknown }
  | { readonly kind: 'rename'; readonly oldUri: Uri; readonly newUri: Uri; readonly options: unknown };

// Not `implements vscode.WorkspaceEdit`: `set` only stores text edits (no snippet/notebook
// overloads). Edits are recorded here; `workspace.applyEdit` decides what to apply.
export class WorkspaceEdit {
  private readonly textEdits = new Map<string, [Uri, TextEdit[]]>();
  private readonly fileOperations: FileOperation[] = [];

  get size(): number {
    return this.textEdits.size + this.fileOperations.length;
  }

  replace(uri: Uri, range: Range, newText: string, _metadata?: vscode.WorkspaceEditEntryMetadata): void {
    this.editsFor(uri).push(new TextEdit(range, newText));
  }

  insert(uri: Uri, position: Position, newText: string, _metadata?: vscode.WorkspaceEditEntryMetadata): void {
    this.editsFor(uri).push(TextEdit.insert(position, newText));
  }

  delete(uri: Uri, range: Range, _metadata?: vscode.WorkspaceEditEntryMetadata): void {
    this.editsFor(uri).push(TextEdit.delete(range));
  }

  has(uri: Uri): boolean {
    const key = uri.toString();
    if (this.textEdits.has(key)) {
      return true;
    }
    return this.fileOperations.some((op) =>
      op.kind === 'rename' ? op.oldUri.toString() === key || op.newUri.toString() === key : op.uri.toString() === key,
    );
  }

  set(uri: Uri, edits: ReadonlyArray<TextEdit>): void {
    this.textEdits.set(uri.toString(), [uri, [...edits]]);
  }

  get(uri: Uri): TextEdit[] {
    return this.textEdits.get(uri.toString())?.[1] ?? [];
  }

  entries(): [Uri, TextEdit[]][] {
    return [...this.textEdits.values()].map(([uri, edits]) => [uri, [...edits]]);
  }

  /** File operations in insertion order (not part of the public vscode API). */
  get fileOps(): readonly FileOperation[] {
    return this.fileOperations;
  }

  createFile(
    uri: Uri,
    options?: {
      readonly overwrite?: boolean;
      readonly ignoreIfExists?: boolean;
      readonly contents?: Uint8Array | vscode.DataTransferFile;
    },
    _metadata?: vscode.WorkspaceEditEntryMetadata,
  ): void {
    this.fileOperations.push({ kind: 'create', uri, options });
  }

  deleteFile(
    uri: Uri,
    options?: { readonly recursive?: boolean; readonly ignoreIfNotExists?: boolean },
    _metadata?: vscode.WorkspaceEditEntryMetadata,
  ): void {
    this.fileOperations.push({ kind: 'delete', uri, options });
  }

  renameFile(
    oldUri: Uri,
    newUri: Uri,
    options?: { readonly overwrite?: boolean; readonly ignoreIfExists?: boolean },
    _metadata?: vscode.WorkspaceEditEntryMetadata,
  ): void {
    this.fileOperations.push({ kind: 'rename', oldUri, newUri, options });
  }

  private editsFor(uri: Uri): TextEdit[] {
    const key = uri.toString();
    const entry = this.textEdits.get(key);
    if (entry) {
      return entry[1];
    }
    const created: [Uri, TextEdit[]] = [uri, []];
    this.textEdits.set(key, created);
    return created[1];
  }
}

export class RelativePattern implements vscode.RelativePattern {
  baseUri: Uri;
  base: string;
  pattern: string;

  constructor(base: vscode.WorkspaceFolder | Uri | string, pattern: string) {
    let uri: Uri;
    if (typeof base === 'string') {
      uri = Uri.file(base);
    } else if ('uri' in base) {
      uri = base.uri;
    } else {
      uri = base;
    }
    this.baseUri = uri;
    this.base = uri.fsPath;
    this.pattern = pattern;
  }
}

export class TabInputText implements vscode.TabInputText {
  readonly uri: Uri;

  constructor(uri: Uri) {
    this.uri = uri;
  }
}

export class TabInputTextDiff implements vscode.TabInputTextDiff {
  readonly original: Uri;
  readonly modified: Uri;

  constructor(original: Uri, modified: Uri) {
    this.original = original;
    this.modified = modified;
  }
}

export class TabInputCustom implements vscode.TabInputCustom {
  readonly uri: Uri;
  readonly viewType: string;

  constructor(uri: Uri, viewType: string) {
    this.uri = uri;
    this.viewType = viewType;
  }
}

export class TabInputWebview implements vscode.TabInputWebview {
  readonly viewType: string;

  constructor(viewType: string) {
    this.viewType = viewType;
  }
}

export class TabInputNotebook implements vscode.TabInputNotebook {
  readonly uri: Uri;
  readonly notebookType: string;

  constructor(uri: Uri, notebookType: string) {
    this.uri = uri;
    this.notebookType = notebookType;
  }
}

export class TabInputNotebookDiff implements vscode.TabInputNotebookDiff {
  readonly original: Uri;
  readonly modified: Uri;
  readonly notebookType: string;

  constructor(original: Uri, modified: Uri, notebookType: string) {
    this.original = original;
    this.modified = modified;
    this.notebookType = notebookType;
  }
}

export class TabInputTerminal implements vscode.TabInputTerminal {}

export class NotebookRange implements vscode.NotebookRange {
  readonly start: number;
  readonly end: number;

  constructor(start: number, end: number) {
    if (start < end) {
      this.start = start;
      this.end = end;
    } else {
      this.start = end;
      this.end = start;
    }
  }

  get isEmpty(): boolean {
    return this.start === this.end;
  }

  with(change: { start?: number; end?: number }): NotebookRange {
    const start = typeof change.start === 'number' ? change.start : this.start;
    const end = typeof change.end === 'number' ? change.end : this.end;
    if (start === this.start && end === this.end) {
      return this;
    }
    return new NotebookRange(start, end);
  }
}

export class NotebookCellOutputItem implements vscode.NotebookCellOutputItem {
  static text(value: string, mime?: string): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), mime ?? 'text/plain');
  }

  static json(value: unknown, mime?: string): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(JSON.stringify(value, undefined, '\t')), mime ?? 'text/x-json');
  }

  static stdout(value: string): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), 'application/vnd.code.notebook.stdout');
  }

  static stderr(value: string): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), 'application/vnd.code.notebook.stderr');
  }

  static error(value: Error): NotebookCellOutputItem {
    // Error's own properties are not enumerable, so pick them explicitly (as VS Code does).
    const json = { name: value.name, message: value.message, stack: value.stack };
    return new NotebookCellOutputItem(new TextEncoder().encode(JSON.stringify(json)), 'application/vnd.code.notebook.error');
  }

  mime: string;
  data: Uint8Array;

  constructor(data: Uint8Array, mime: string) {
    this.data = data;
    this.mime = mime;
  }
}

export class NotebookCellOutput implements vscode.NotebookCellOutput {
  items: NotebookCellOutputItem[];
  metadata?: { [key: string]: unknown };

  constructor(items: NotebookCellOutputItem[], metadata?: { [key: string]: unknown }) {
    this.items = items;
    this.metadata = metadata;
  }
}

// Not `implements vscode.NotebookCellData`: `kind` uses this module's `NotebookCellKind`
// enum, which is nominally incompatible with `vscode.NotebookCellKind`.
export class NotebookCellData {
  kind: NotebookCellKind;
  value: string;
  languageId: string;
  outputs?: NotebookCellOutput[];
  metadata?: { [key: string]: unknown };
  executionSummary?: vscode.NotebookCellExecutionSummary;

  constructor(kind: NotebookCellKind, value: string, languageId: string) {
    this.kind = kind;
    this.value = value;
    this.languageId = languageId;
  }
}

// Not `implements vscode.NotebookEdit`: `newCells` uses `NotebookCellData`, whose `kind`
// enum is nominally incompatible with the vscode type.
export class NotebookEdit {
  static replaceCells(range: NotebookRange, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(range, newCells);
  }

  static insertCells(index: number, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(new NotebookRange(index, index), newCells);
  }

  static deleteCells(range: NotebookRange): NotebookEdit {
    return new NotebookEdit(range, []);
  }

  static updateCellMetadata(index: number, newCellMetadata: { [key: string]: unknown }): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(index, index), []);
    edit.newCellMetadata = newCellMetadata;
    return edit;
  }

  static updateNotebookMetadata(newNotebookMetadata: { [key: string]: unknown }): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(0, 0), []);
    edit.newNotebookMetadata = newNotebookMetadata;
    return edit;
  }

  range: NotebookRange;
  newCells: NotebookCellData[];
  newCellMetadata?: { [key: string]: unknown };
  newNotebookMetadata?: { [key: string]: unknown };

  constructor(range: NotebookRange, newCells: NotebookCellData[]) {
    this.range = range;
    this.newCells = newCells;
  }
}
