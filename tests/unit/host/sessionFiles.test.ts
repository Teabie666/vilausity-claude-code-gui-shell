import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { deleteSession, isSessionId, sessionPaths, waitForSessionEnd } from '../../../src/host/main/sessionFiles';
import { processRuns, sessionProcesses, waitForExit } from '../../../src/host/node/claudeProcesses';

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

  test('the processes that run a session, by the records they keep while they run', async () => {
    const { root } = claudeFolder();
    try {
      const records = path.join(root, 'sessions');
      mkdirSync(records);
      writeFileSync(path.join(records, '101.json'), JSON.stringify({ pid: 101, sessionId: ID, kind: 'interactive' }));
      // Left behind by a crash: the process is gone.
      writeFileSync(path.join(records, '102.json'), JSON.stringify({ pid: 102, sessionId: ID }));
      writeFileSync(path.join(records, '103.json'), JSON.stringify({ pid: 103, sessionId: OTHER }));
      writeFileSync(path.join(records, '104.json'), '{"pid": 104, "sessi');
      writeFileSync(path.join(records, '101.6ea1.key'), 'not a record');
      const runs = (pid: number): boolean => pid !== 102;
      assert.deepEqual(await sessionProcesses(root, ID, runs), [101]);
      assert.deepEqual(await sessionProcesses(root, OTHER, runs), [103]);
      assert.deepEqual(await sessionProcesses(path.join(root, 'nowhere'), ID, runs), []);
      // This test's own process runs; a process id nobody has does not.
      assert.equal(processRuns(process.pid), true);
      assert.equal(processRuns(2 ** 31 - 2), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('waits for a session to stop running, and gives up after a while', async () => {
    const { root } = claudeFolder();
    try {
      mkdirSync(path.join(root, 'sessions'));
      writeFileSync(path.join(root, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: ID }));
      let ended = false;
      const runs = (): boolean => !ended;
      setTimeout(() => (ended = true), 50);
      assert.equal(await waitForSessionEnd(root, ID, 2000, runs, 10), true);
      ended = false;
      const started = Date.now();
      assert.equal(await waitForSessionEnd(root, ID, 100, runs, 10), false);
      assert.ok(Date.now() - started >= 100);
      // Nothing runs it: no waiting at all.
      assert.equal(await waitForSessionEnd(root, OTHER, 0, runs), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('waits for processes to end, records or not, and gives up after a while', async () => {
    const running = new Set([101, 102]);
    const runs = (pid: number): boolean => running.has(pid);
    setTimeout(() => running.delete(101), 30);
    setTimeout(() => running.delete(102), 60);
    assert.equal(await waitForExit([101, 102], 2000, runs, 10), true);
    assert.equal(running.size, 0);
    running.add(103);
    const started = Date.now();
    assert.equal(await waitForExit([103], 100, runs, 10), false);
    assert.ok(Date.now() - started >= 100);
    assert.equal(await waitForExit([], 0, runs), true);
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
