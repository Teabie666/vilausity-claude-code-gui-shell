/**
 * Monaco text models for the documents shown in editors, shared by every editor that shows
 * the same URI. A model owns its document's text: user edits are mirrored to the extension
 * host as `document.didChange`, and edits from there are applied to the model (and then
 * mirrored back like any other change). Dirty state is the model's distance from the
 * version last saved.
 */

import { Emitter, type Event } from '../../platform/event';
import type { IDisposable } from '../../platform/lifecycle';
import type { ILogger } from '../../platform/log';
import type { DocumentSnapshot, RangeDto, TextEditDto } from '../../platform/protocol';
import type { ExtensionHostConnection } from '../../core/extensionHost';
import type { Highlighting } from './highlighting';
import type { MonacoApi } from './monaco';

export type TextModel = ReturnType<MonacoApi['editor']['createModel']>;
type IRange = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

export function toMonacoRange(range: RangeDto): IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

export function fromMonacoRange(range: IRange): RangeDto {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

/** The smallest single replacement that turns `before` into `after` (common prefix and suffix kept). */
export function minimalReplacement(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) {
    start++;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore--;
    endAfter--;
  }
  return { start, end: endBefore, text: after.slice(start, endAfter) };
}

export interface ModelEntry {
  readonly uri: string;
  readonly model: TextModel;
  readonly readOnly: boolean;
  readonly isDirty: boolean;
  readonly onDidChangeDirty: Event<boolean>;
  /** Changed on disk while it had unsaved changes. */
  readonly onDidConflict: Event<void>;
}

class Entry implements ModelEntry {
  refs = 0;
  isDirty: boolean;
  savedVersion: number;
  readonly dirtyEmitter = new Emitter<boolean>();
  readonly onDidChangeDirty = this.dirtyEmitter.event;
  readonly conflictEmitter = new Emitter<void>();
  readonly onDidConflict = this.conflictEmitter.event;
  subscription: IDisposable | undefined;

  constructor(
    readonly uri: string,
    readonly model: TextModel,
    readonly readOnly: boolean,
    dirty: boolean,
  ) {
    this.isDirty = dirty;
    // A document that arrives dirty stays dirty until saved.
    this.savedVersion = dirty ? -1 : model.getAlternativeVersionId();
  }
}

export interface ModelReference extends IDisposable {
  readonly entry: ModelEntry;
}

/**
 * The Monaco language of a document: JSON with comments is `json` there, which Monaco's
 * JSON language service (completion, hovers, validation) serves, with comments allowed.
 */
export function monacoLanguageFor(languageId: string): string {
  return languageId === 'jsonc' ? 'json' : languageId;
}

export class TextModels {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly monaco: MonacoApi,
    private readonly highlighting: Highlighting,
    private readonly connection: ExtensionHostConnection,
    private readonly logger: ILogger,
    /** Applied to each new model (indentation settings). */
    private readonly configureModel: (model: TextModel) => void = () => {},
  ) {}

  forEachModel(callback: (model: TextModel) => void): void {
    for (const entry of this.entries.values()) {
      callback(entry.model);
    }
  }

  /** The model for `snapshot.uri`, created from the snapshot the first time; release with dispose(). */
  acquire(snapshot: DocumentSnapshot): ModelReference {
    let entry = this.entries.get(snapshot.uri);
    if (!entry) {
      const language = monacoLanguageFor(snapshot.languageId);
      void this.highlighting.ensureLanguage(language);
      const model = this.monaco.editor.createModel(snapshot.text, language, this.monaco.Uri.parse(snapshot.uri));
      this.configureModel(model);
      const created = new Entry(snapshot.uri, model, snapshot.readOnly, snapshot.isDirty);
      created.subscription = model.onDidChangeContent((event) => {
        this.connection.rpc?.notify('document.didChange', {
          uri: created.uri,
          changes: event.changes.map((change) => ({
            range: fromMonacoRange(change.range),
            rangeOffset: change.rangeOffset,
            rangeLength: change.rangeLength,
            text: change.text,
          })),
          isUndoing: event.isUndoing,
          isRedoing: event.isRedoing,
        });
        this.updateDirty(created);
      });
      entry = created;
      this.entries.set(snapshot.uri, entry);
    }
    entry.refs++;
    const acquired = entry;
    let disposed = false;
    return {
      entry: acquired,
      dispose: () => {
        if (!disposed) {
          disposed = true;
          this.release(acquired);
        }
      },
    };
  }

  get(uri: string): ModelEntry | undefined {
    return this.entries.get(uri);
  }

  /** Saves through the extension host. Resolves to false when it could not be saved. */
  async save(uri: string): Promise<boolean> {
    const entry = this.entries.get(uri);
    const rpc = this.connection.rpc;
    if (!entry || !rpc) {
      return false;
    }
    const version = entry.model.getAlternativeVersionId();
    const saved = await rpc.call('document.save', { uri });
    if (saved) {
      this.markSaved(entry, version);
    }
    return saved;
  }

  /** Drops unsaved changes: the extension host answers with `document.reload`. */
  revert(uri: string): Promise<void> {
    return this.connection.rpc?.call('document.revert', { uri }) ?? Promise.resolve();
  }

  // ---- requests from the extension host -------------------------------------------

  applyEdits(uri: string, edits: readonly TextEditDto[]): boolean {
    const entry = this.entries.get(uri);
    if (!entry) {
      return false;
    }
    entry.model.pushEditOperations(
      [],
      edits.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.text })),
      () => null,
    );
    return true;
  }

  /** The text on disk replaces the model's (external change or revert); the model is clean after. */
  reload(uri: string, text: string): void {
    const entry = this.entries.get(uri);
    if (!entry) {
      return;
    }
    const model = entry.model;
    const current = model.getValue();
    if (current !== text) {
      // A minimal edit keeps the cursor and scroll position where the text did not change.
      const { start, end, text: replacement } = minimalReplacement(current, text);
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(end);
      model.pushEditOperations(
        [],
        [
          {
            range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column },
            text: replacement,
          },
        ],
        () => null,
      );
    }
    this.markSaved(entry, model.getAlternativeVersionId());
  }

  didSave(uri: string): void {
    const entry = this.entries.get(uri);
    if (entry) {
      this.markSaved(entry, entry.model.getAlternativeVersionId());
    }
  }

  didChangeOnDisk(uri: string): void {
    this.entries.get(uri)?.conflictEmitter.fire();
  }

  /** The extension host went away; nothing can be saved until it is back. */
  disposeAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.destroy(entry);
    }
  }

  private markSaved(entry: Entry, version: number): void {
    entry.savedVersion = version;
    this.updateDirty(entry);
  }

  private updateDirty(entry: Entry): void {
    const dirty = entry.model.getAlternativeVersionId() !== entry.savedVersion;
    if (dirty !== entry.isDirty) {
      entry.isDirty = dirty;
      this.connection.rpc?.notify('document.didChangeDirty', { uri: entry.uri, isDirty: dirty });
      entry.dirtyEmitter.fire(dirty);
    }
  }

  private release(entry: Entry): void {
    entry.refs--;
    if (entry.refs <= 0 && this.entries.get(entry.uri) === entry) {
      this.destroy(entry);
    }
  }

  private destroy(entry: Entry): void {
    this.entries.delete(entry.uri);
    entry.subscription?.dispose();
    entry.dirtyEmitter.dispose();
    entry.conflictEmitter.dispose();
    try {
      entry.model.dispose();
    } catch (error) {
      this.logger.warn(`disposing the model of ${entry.uri} failed`, error);
    }
  }
}
