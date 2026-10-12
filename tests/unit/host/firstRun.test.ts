import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { parseCliArgs } from '../../../src/host/main/cli';
import { locateClaudeExtension, type LocatedExtension } from '../../../src/host/main/extensionLocator';
import { findGit } from '../../../src/host/main/gitLocator';

const only =
  (...files: string[]) =>
  (file: string): boolean =>
    files.includes(file);

describe('findGit', () => {
  test('on PATH', () => {
    const git = path.join('C:\\tools\\git\\cmd', 'git.exe');
    const env = { PATH: ['C:\\nothing', 'C:\\tools\\git\\cmd'].join(path.delimiter) };
    assert.equal(findGit(env, only(git)), git);
  });

  test('not in the install folder when PATH lacks it: Claude Code would not find it either', () => {
    const machine = path.join('C:\\Program Files', 'Git', 'cmd', 'git.exe');
    assert.equal(findGit({ PATH: 'C:\\nothing', ProgramFiles: 'C:\\Program Files' }, only(machine)), undefined);
  });

  test('CLAUDE_CODE_GIT_BASH_PATH counts when the file is there', () => {
    const bash = 'D:\\PortableGit\\bin\\bash.exe';
    assert.equal(findGit({ CLAUDE_CODE_GIT_BASH_PATH: bash }, only(bash)), bash);
    assert.equal(
      findGit({ CLAUDE_CODE_GIT_BASH_PATH: bash }, () => false),
      undefined,
    );
  });

  test('missing', () => {
    assert.equal(
      findGit({ PATH: 'C:\\a', ProgramFiles: 'C:\\Program Files' }, () => false),
      undefined,
    );
    assert.equal(
      findGit({}, () => false),
      undefined,
    );
  });
});

describe('first run', () => {
  test('--ignore-other-editors', () => {
    assert.equal(parseCliArgs(['--ignore-other-editors']).ignoreOtherEditors, true);
    assert.equal(parseCliArgs([]).ignoreOtherEditors, false);
  });

  test("without other editors' copies, only the managed one counts", () => {
    assert.equal(locateClaudeExtension(undefined, undefined, false), undefined);
    const managed: LocatedExtension = { path: 'x', version: '1.0.0', source: 'y', kind: 'managed' };
    assert.equal(locateClaudeExtension(undefined, managed, false), managed);
  });
});
