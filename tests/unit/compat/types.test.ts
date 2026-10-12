import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  Disposable,
  FileSystemError,
  MarkdownString,
  OverviewRulerLane,
  Position,
  ProgressLocation,
  Range,
  RelativePattern,
  Selection,
  ViewColumn,
  WorkspaceEdit,
} from '../../../src/compat/vscode/types';
import { Uri } from '../../../src/compat/vscode/uri';

describe('Position', () => {
  test('compares by line then character', () => {
    const a = new Position(1, 5);
    const b = new Position(2, 0);
    const c = new Position(1, 9);
    assert.equal(a.isBefore(b), true);
    assert.equal(a.isBefore(c), true);
    assert.equal(a.isBefore({ line: 1, character: 5 }), false);
    assert.equal(a.isBeforeOrEqual({ line: 1, character: 5 }), true);
    assert.equal(b.isAfter(a), true);
    assert.equal(a.isAfterOrEqual({ line: 1, character: 5 }), true);
    assert.equal(a.isEqual({ line: 1, character: 5 }), true);
    assert.equal(a.isEqual(c), false);
    assert.equal(a.compareTo(b), -1);
    assert.equal(b.compareTo(a), 1);
    assert.equal(a.compareTo({ line: 1, character: 5 }), 0);
  });

  test('translate and with support both overloads and return this for a no-op', () => {
    const p = new Position(2, 4);
    assert.equal(p.translate(), p);
    assert.equal(p.translate(0, 0), p);

    const t1 = p.translate(1, -2);
    assert.equal(t1.line, 3);
    assert.equal(t1.character, 2);

    const t2 = p.translate({ lineDelta: -1, characterDelta: 5 });
    assert.equal(t2.line, 1);
    assert.equal(t2.character, 9);

    const t3 = p.translate({ characterDelta: 1 });
    assert.equal(t3.line, 2);
    assert.equal(t3.character, 5);

    assert.equal(p.with(), p);
    assert.equal(p.with({ line: 2, character: 4 }), p);

    const w1 = p.with(3, 0);
    assert.equal(w1.line, 3);
    assert.equal(w1.character, 0);

    const w2 = p.with({ character: 7 });
    assert.equal(w2.line, 2);
    assert.equal(w2.character, 7);
  });

  test('throws for negative line or character', () => {
    assert.throws(() => new Position(-1, 0), /line must be non-negative/);
    assert.throws(() => new Position(0, -1), /character must be non-negative/);
  });
});

describe('Range', () => {
  test('accepts positions and plain objects and swaps so start <= end', () => {
    const r = new Range(new Position(2, 3), new Position(1, 1));
    assert.equal(r.start.line, 1);
    assert.equal(r.start.character, 1);
    assert.equal(r.end.line, 2);
    assert.equal(r.end.character, 3);

    const fromPlain = new Range({ line: 0, character: 5 }, { line: 0, character: 9 });
    assert.equal(fromPlain.start.character, 5);
    assert.equal(fromPlain.end.character, 9);
    assert.equal(fromPlain.isSingleLine, true);

    const byNumbers = new Range(3, 4, 3, 4);
    assert.equal(byNumbers.isEmpty, true);

    const swappedNumbers = new Range(5, 0, 1, 0);
    assert.equal(swappedNumbers.start.line, 1);
    assert.equal(swappedNumbers.end.line, 5);
  });

  test('contains positions and ranges inclusively', () => {
    const r = new Range(new Position(1, 2), new Position(4, 5));
    assert.equal(r.contains(new Position(2, 0)), true);
    assert.equal(r.contains(new Position(1, 2)), true);
    assert.equal(r.contains(new Position(4, 5)), true);
    assert.equal(r.contains(new Position(0, 0)), false);
    assert.equal(r.contains(new Position(4, 6)), false);
    assert.equal(r.contains(new Range(new Position(2, 0), new Position(3, 0))), true);
    assert.equal(r.contains(new Range(new Position(0, 0), new Position(2, 0))), false);
  });

  test('intersection returns the overlap or undefined when disjoint', () => {
    const a = new Range(new Position(0, 0), new Position(5, 5));
    const b = new Range(new Position(3, 0), new Position(8, 0));
    const overlap = a.intersection(b);
    assert.ok(overlap);
    assert.equal(overlap!.start.line, 3);
    assert.equal(overlap!.end.line, 5);

    const disjoint = new Range(new Position(6, 0), new Position(9, 0));
    assert.equal(a.intersection(disjoint), undefined);
  });

  test('union spans both ranges and with supports both overloads', () => {
    const a = new Range(new Position(0, 0), new Position(2, 0));
    const b = new Range(new Position(1, 0), new Position(4, 0));
    const union = a.union(b);
    assert.equal(union.start.line, 0);
    assert.equal(union.end.line, 4);

    const inner = new Range(new Position(1, 0), new Position(1, 5));
    assert.equal(a.union(inner), a);

    const w1 = a.with(new Position(0, 5), new Position(2, 5));
    assert.equal(w1.start.character, 5);
    assert.equal(w1.end.character, 5);

    assert.equal(a.with(new Position(0, 0), new Position(2, 0)), a);

    const w2 = a.with({ end: new Position(3, 0) });
    assert.equal(w2.start.line, 0);
    assert.equal(w2.end.line, 3);
  });
});

describe('Selection', () => {
  test('keeps anchor and active and reports isReversed', () => {
    const forward = new Selection(new Position(0, 0), new Position(0, 5));
    assert.equal(forward.anchor.character, 0);
    assert.equal(forward.active.character, 5);
    assert.equal(forward.isReversed, false);
    assert.equal(forward.start, forward.anchor);
    assert.equal(forward.end, forward.active);

    const reversed = new Selection(new Position(0, 5), new Position(0, 0));
    assert.equal(reversed.anchor.character, 5);
    assert.equal(reversed.active.character, 0);
    assert.equal(reversed.isReversed, true);
    assert.equal(reversed.start.character, 0);
    assert.equal(reversed.end.character, 5);
    assert.equal(reversed.end, reversed.anchor);

    const byNumbers = new Selection(1, 2, 1, 6);
    assert.equal(byNumbers.anchor.line, 1);
    assert.equal(byNumbers.anchor.character, 2);
    assert.equal(byNumbers.active.character, 6);
  });
});

describe('Disposable', () => {
  test('Disposable.from disposes every entry exactly once', () => {
    const order: string[] = [];
    const d = Disposable.from({ dispose: () => order.push('a') }, { dispose: () => order.push('b') });
    d.dispose();
    d.dispose();
    assert.deepEqual(order, ['a', 'b']);
  });
});

describe('FileSystemError', () => {
  // As in VS Code: `code` is the factory's name, `name` carries the provider error code.
  test('each factory sets its code and name like VS Code', () => {
    const cases: Array<[FileSystemError, string, string]> = [
      [FileSystemError.FileNotFound('nope'), 'FileNotFound', 'EntryNotFound (FileSystemError)'],
      [FileSystemError.FileExists('dup'), 'FileExists', 'EntryExists (FileSystemError)'],
      [FileSystemError.FileNotADirectory('x'), 'FileNotADirectory', 'EntryNotADirectory (FileSystemError)'],
      [FileSystemError.FileIsADirectory('y'), 'FileIsADirectory', 'EntryIsADirectory (FileSystemError)'],
      [FileSystemError.NoPermissions('z'), 'NoPermissions', 'NoPermissions (FileSystemError)'],
      [FileSystemError.Unavailable('u'), 'Unavailable', 'Unavailable (FileSystemError)'],
    ];
    for (const [err, code, name] of cases) {
      assert.ok(err instanceof FileSystemError);
      assert.ok(err instanceof Error);
      assert.equal(err.code, code);
      assert.equal(err.name, name);
    }
  });

  test('direct construction defaults code to Unknown and name to Unknown (FileSystemError)', () => {
    const err = new FileSystemError('custom message');
    assert.equal(err.code, 'Unknown');
    assert.equal(err.name, 'Unknown (FileSystemError)');
    assert.equal(err.message, 'custom message');
    assert.ok(err instanceof FileSystemError);
  });

  test('a Uri argument becomes the message, unencoded', () => {
    assert.equal(FileSystemError.FileNotFound(Uri.file('/a b/c.txt')).message, 'file:///a b/c.txt');
  });
});

describe('RelativePattern', () => {
  test('accepts string, Uri and WorkspaceFolder bases', () => {
    const fromString = new RelativePattern('src', '**/*.ts');
    assert.equal(fromString.pattern, '**/*.ts');
    assert.equal(fromString.base, Uri.file('src').fsPath);

    const uri = Uri.file('/proj');
    const fromUri = new RelativePattern(uri, '**/*.js');
    assert.equal(fromUri.baseUri, uri);
    assert.equal(fromUri.base, uri.fsPath);
    assert.equal(fromUri.pattern, '**/*.js');

    const folder = { uri, name: 'proj', index: 0 };
    const fromFolder = new RelativePattern(folder, '**/*.json');
    assert.equal(fromFolder.baseUri, uri);
    assert.equal(fromFolder.base, uri.fsPath);
    assert.equal(fromFolder.pattern, '**/*.json');
  });
});

describe('MarkdownString', () => {
  test('appendCodeblock omits the language when none is given', () => {
    const md = new MarkdownString();
    md.appendCodeblock('const x = 1;');
    assert.equal(md.value, '\n```\nconst x = 1;\n```\n');
    assert.equal(md.value.includes('undefined'), false);
  });

  test('appendCodeblock includes a language and appendText escapes syntax tokens', () => {
    const md = new MarkdownString();
    md.appendCodeblock('let x', 'typescript');
    assert.equal(md.value, '\n```typescript\nlet x\n```\n');
    md.appendText('a*b_c');
    assert.equal(md.value, '\n```typescript\nlet x\n```\na\\*b\\_c');
  });

  test('appendMarkdown appends raw and the constructor stores the value', () => {
    const md = new MarkdownString('# hi');
    md.appendMarkdown(' **bold**');
    assert.equal(md.value, '# hi **bold**');
  });
});

describe('WorkspaceEdit', () => {
  test('replace, insert and delete record edits per uri', () => {
    const uri = Uri.file('/f.txt');
    const edit = new WorkspaceEdit();
    assert.equal(edit.size, 0);
    assert.equal(edit.has(uri), false);

    edit.replace(uri, new Range(0, 0, 0, 3), 'abc');
    edit.insert(uri, new Position(1, 0), '\n');
    edit.delete(uri, new Range(2, 0, 2, 5));

    assert.equal(edit.size, 1);
    assert.equal(edit.has(uri), true);
    assert.equal(edit.has(Uri.file('/other.txt')), false);

    const entries = edit.entries();
    assert.equal(entries.length, 1);
    const [entryUri, edits] = entries[0];
    assert.equal(entryUri, uri);
    assert.equal(edits.length, 3);
    assert.equal(edits[0].newText, 'abc');
    assert.equal(edits[0].range.start.line, 0);
    assert.equal(edits[0].range.end.character, 3);
    assert.equal(edits[1].newText, '\n');
    assert.equal(edits[2].newText, '');
  });
});

describe('enums', () => {
  test('ViewColumn, ProgressLocation and OverviewRulerLane match vscode values', () => {
    assert.equal(ViewColumn.Active, -1);
    assert.equal(ViewColumn.Beside, -2);
    assert.equal(ViewColumn.One, 1);
    assert.equal(ViewColumn.Nine, 9);

    assert.equal(ProgressLocation.SourceControl, 1);
    assert.equal(ProgressLocation.Window, 10);
    assert.equal(ProgressLocation.Notification, 15);

    assert.equal(OverviewRulerLane.Left, 1);
    assert.equal(OverviewRulerLane.Center, 2);
    assert.equal(OverviewRulerLane.Right, 4);
    assert.equal(OverviewRulerLane.Full, 7);
  });
});
