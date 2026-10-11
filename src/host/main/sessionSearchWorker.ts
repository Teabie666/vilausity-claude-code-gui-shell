/** The worker thread of the session search (sessionSearch.ts): holds the index, answers searches. */

import { parentPort, workerData } from 'node:worker_threads';
import type { SessionSearchRequest } from '../../platform/protocol';
import { SessionIndex } from './sessionSearch';

const index = new SessionIndex((workerData as { projectsDir: string }).projectsDir);

parentPort?.on('message', (message: { id: number; request: SessionSearchRequest }) => {
  index.search(message.request).then(
    (results) => parentPort?.postMessage({ id: message.id, results }),
    (error: unknown) => parentPort?.postMessage({ id: message.id, error: String(error) }),
  );
});
