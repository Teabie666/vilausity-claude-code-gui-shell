/**
 * The sessions worker thread (sessionSearch.ts): holds the search index and the usage index
 * (sessionUsage.ts), and answers searches and usage questions.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { SessionSearchRequest } from '../../platform/protocol';
import { SessionIndex } from './sessionSearch';
import { UsageIndex, type UsageRequest } from './sessionUsage';

const data = workerData as { projectsDir: string; tagsFile: string };
const index = new SessionIndex(data.projectsDir);
const usage = new UsageIndex(data.projectsDir, data.tagsFile);

type WorkerRequest = { id: number; kind: 'search'; request: SessionSearchRequest } | { id: number; kind: 'usage'; request: UsageRequest };

parentPort?.on('message', (message: WorkerRequest) => {
  const answer: Promise<unknown> = message.kind === 'search' ? index.search(message.request) : usage.answer(message.request);
  answer.then(
    (result) => parentPort?.postMessage({ id: message.id, result }),
    (error: unknown) => parentPort?.postMessage({ id: message.id, error: String(error) }),
  );
});
