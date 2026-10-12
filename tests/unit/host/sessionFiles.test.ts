import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { deleteSession, isSessionId, sessionPaths } from '../../../src/host/main/sessionFiles';

const ID = '0f9c2b1e-4d5a-4c3b-9e8f-7a6b5c4d3e2f';
const OTHER = '11111111-2222-4333-8444-555555555555';

/** A Claude Code folder with the session in two projects' worth of places, and another session. */
function claudeFolder(): { root: string; projects: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-sessions-'));
  const projects = path.join(root, 'projects');
  for (const project of ['C--work-shop', 'C--home']) {
    mkdirSync(path.join(projects, project), { recursive: true });
  }
  writeFileSync(path.join(projects, 'C--work-shop', `${ID}.jsonl`), '{}\n');
  mkdirSync(path.join(projects, 'C--work-shop', ID, 'subagents'), { recursive: true });
  writeFileSync(path.join(projects, 'C--work-shop', ID, 'subagents', 'agent-1.jsonl'), '{}\n');
  mkdirSync(path.join(root, 'file-history', ID), { recursive: true });
  mkdirSync(path.join(root, 'session-env', ID), { recursive: true });
  writeFileSync(path.join(projects, 'C--home', `${OTHER}.jsonl`), '{}\n');
  mkdirSync(path.join(root, 'file-history', OTHER), { recursive: true });
  writeFileSync(path.join(root, 'history.jsonl'), `{"sessionId":"${ID}"}\n`);
  return { root, projects };
}

describe('session files', () => {
  test('a session id is a UUID and nothing else', () => {
    assert.equal(isSessionId(ID), true);
    assert.equal(isSessionId(ID.toUpperCase()), true);
    for (const bad of ['', '..', `../${ID}`, `${ID}/..`, `${ID}.jsonl`, 'sessions-list-row-3', '3']) {
      assert.equal(isSessionId(bad), false, bad);
    }
  });

  test('finds what Claude Code keeps of a session, the transcript last', async () => {
    const { root, projects } = claudeFolder();
    try {
      const found = await sessionPaths(projects, ID);
      assert.deepEqual(found, [
        path.join(root, 'file-history', ID),
        path.join(root, 'session-env', ID),
        path.join(projects, 'C--work-shop', ID),
        path.join(projects, 'C--work-shop', `${ID}.jsonl`),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('deletes the session and nothing else; the prompt history stays', async () => {
    const { root, projects } = claudeFolder();
    try {
      const deleted = await deleteSession(projects, ID);
      assert.equal(deleted.transcript, true);
      assert.equal(deleted.paths.length, 4);
      for (const gone of deleted.paths) {
        assert.equal(existsSync(gone), false, gone);
      }
      assert.equal(existsSync(path.join(projects, 'C--home', `${OTHER}.jsonl`)), true);
      assert.equal(existsSync(path.join(root, 'file-history', OTHER)), true);
      assert.equal(existsSync(path.join(root, 'history.jsonl')), true);
      // Again: nothing left to find.
      assert.deepEqual(await deleteSession(projects, ID), { paths: [], transcript: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses anything that is not a session id, before touching the disk', async () => {
    const { root, projects } = claudeFolder();
    try {
      await assert.rejects(deleteSession(projects, '..'), /not a session id/);
      await assert.rejects(deleteSession(projects, `../${ID}`), /not a session id/);
      assert.equal(existsSync(path.join(projects, 'C--work-shop', `${ID}.jsonl`)), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a missing Claude Code folder has nothing to delete', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vilaus-sessions-'));
    try {
      assert.deepEqual(await deleteSession(path.join(root, 'projects'), ID), { paths: [], transcript: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
