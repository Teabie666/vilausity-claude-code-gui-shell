import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

import { AutoSave, autoSaveMode, type AutoSaveMode } from '../../../src/features/editor/autoSave';
import type { ModelEntry } from '../../../src/features/editor/textModels';
import { Emitter } from '../../../src/platform/event';
import type { ILogger } from '../../../src/platform/log';

const logger = { warn() {}, info() {}, error() {}, debug() {}, trace() {}, child: () => logger } as unknown as ILogger;

interface FakeEntry extends ModelEntry {
  isDirty: boolean;
  readonly dirtyEmitter: Emitter<boolean>;
  readonly conflictEmitter: Emitter<void>;
}

function entry(uri: string, options: { readOnly?: boolean; dirty?: boolean } = {}): FakeEntry {
  const dirtyEmitter = new Emitter<boolean>();
  const conflictEmitter = new Emitter<void>();
  return {
    uri,
    model: undefined as unknown as ModelEntry['model'],
    readOnly: options.readOnly ?? false,
    isDirty: options.dirty ?? true,
    dirtyEmitter,
    conflictEmitter,
    onDidChangeDirty: dirtyEmitter.event,
    onDidConflict: conflictEmitter.event,
  };
}

function setup(mode: AutoSaveMode, entries: FakeEntry[], saveResult = true) {
  const state = { mode, saveResult };
  const saved: string[] = [];
  const failures: string[] = [];
  const autoSave = new AutoSave(
    {
      mode: () => state.mode,
      delay: () => 1000,
      dirty: () => entries.filter((candidate) => candidate.isDirty),
      save: async (uri) => {
        saved.push(uri);
        const found = entries.find((candidate) => candidate.uri === uri);
        if (state.saveResult && found) {
          found.isDirty = false;
          found.dirtyEmitter.fire(false);
        }
        return state.saveResult;
      },
      reportFailure: (uri) => failures.push(uri),
    },
    logger,
  );
  return { autoSave, saved, failures, state };
}

/** Lets the saves' promises settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('auto save (files.autoSave)', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  test('afterDelay saves a file the delay after its last change', async () => {
    const file = entry('file:///w/a.ts');
    const { autoSave, saved } = setup('afterDelay', [file]);
    autoSave.didChangeContent(file);
    mock.timers.tick(600);
    autoSave.didChangeContent(file);
    mock.timers.tick(600);
    assert.deepEqual(saved, [], 'the second change restarts the delay');
    mock.timers.tick(400);
    await settle();
    assert.deepEqual(saved, ['file:///w/a.ts']);
  });

  test('only files on disk with changes are saved: not the extension’s documents, read-only ones or clean ones', async () => {
    const proposed = entry('_claude_vscode_fs_right:/w/a.ts');
    const readOnly = entry('file:///w/b.ts', { readOnly: true });
    const clean = entry('file:///w/c.ts', { dirty: false });
    const { autoSave, saved } = setup('afterDelay', [proposed, readOnly, clean]);
    for (const candidate of [proposed, readOnly, clean]) {
      autoSave.didChangeContent(candidate);
    }
    autoSave.didBlurWindow();
    mock.timers.tick(5000);
    await settle();
    assert.deepEqual(saved, []);
  });

  test('off saves nothing by itself', async () => {
    const file = entry('file:///w/a.ts');
    const { autoSave, saved } = setup('off', [file]);
    autoSave.didChangeContent(file);
    autoSave.didBlurEditor(file.uri);
    autoSave.didBlurWindow();
    mock.timers.tick(5000);
    await settle();
    assert.deepEqual(saved, []);
  });

  test('onFocusChange saves the editor that lost focus, and everything when the window does', async () => {
    const a = entry('file:///w/a.ts');
    const b = entry('file:///w/b.ts');
    const { autoSave, saved } = setup('onFocusChange', [a, b]);
    autoSave.didChangeContent(a);
    mock.timers.tick(5000);
    await settle();
    assert.deepEqual(saved, [], 'no delay in this mode');
    autoSave.didBlurEditor(a.uri);
    await settle();
    assert.deepEqual(saved, [a.uri]);
    autoSave.didBlurWindow();
    await settle();
    assert.deepEqual(saved, [a.uri, b.uri]);
  });

  test('onWindowChange saves when the window loses focus, not when an editor does', async () => {
    const a = entry('file:///w/a.ts');
    const { autoSave, saved } = setup('onWindowChange', [a]);
    autoSave.didBlurEditor(a.uri);
    await settle();
    assert.deepEqual(saved, []);
    autoSave.didBlurWindow();
    await settle();
    assert.deepEqual(saved, [a.uri]);
  });

  test('a file changed on disk while it had changes waits for the user, until it is in step again', async () => {
    const file = entry('file:///w/a.ts');
    const { autoSave, saved } = setup('onWindowChange', [file]);
    autoSave.didChangeContent(file);
    file.conflictEmitter.fire();
    autoSave.didBlurWindow();
    await settle();
    assert.deepEqual(saved, [], 'saving would overwrite what changed on disk');
    // Reloaded (or saved by the user): clean, then edited again.
    file.isDirty = false;
    file.dirtyEmitter.fire(false);
    file.isDirty = true;
    autoSave.didBlurWindow();
    await settle();
    assert.deepEqual(saved, [file.uri]);
  });

  test('a failure is reported once, until a save of that file works', async () => {
    const file = entry('file:///w/a.ts');
    const { autoSave, failures, state } = setup('onWindowChange', [file], false);
    autoSave.didBlurWindow();
    await settle();
    autoSave.didBlurWindow();
    await settle();
    assert.deepEqual(failures, [file.uri]);
    state.saveResult = true;
    autoSave.didBlurWindow();
    await settle();
    state.saveResult = false;
    file.isDirty = true;
    autoSave.didBlurWindow();
    await settle();
    assert.deepEqual(failures, [file.uri, file.uri]);
  });

  test('turning afterDelay on saves what is unsaved; turning it off drops pending saves', async () => {
    const a = entry('file:///w/a.ts');
    const { autoSave, saved, state } = setup('off', [a]);
    autoSave.didChangeContent(a);
    state.mode = 'afterDelay';
    autoSave.didChangeMode();
    mock.timers.tick(1000);
    await settle();
    assert.deepEqual(saved, [a.uri]);
    a.isDirty = true;
    autoSave.didChangeContent(a);
    state.mode = 'off';
    autoSave.didChangeMode();
    mock.timers.tick(5000);
    await settle();
    assert.deepEqual(saved, [a.uri]);
  });

  test('unknown values of the setting mean off', () => {
    assert.equal(autoSaveMode('afterDelay'), 'afterDelay');
    assert.equal(autoSaveMode('sometimes'), 'off');
    assert.equal(autoSaveMode(undefined), 'off');
  });
});
