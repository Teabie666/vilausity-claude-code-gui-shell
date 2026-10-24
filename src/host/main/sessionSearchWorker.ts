/**
 * The sessions worker thread (sessionSearch.ts): holds the search index and the usage index
 * (sessionUsage.ts), answers searches and usage questions, writes full transcripts
 * (fullTranscripts.ts) and measures the sessions' room on disk (sessionStorage.ts).
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { SessionSearchRequest } from '../../platform/protocol';
import { writeFullTranscript, type FullTranscriptRequest } from './fullTranscripts';
import { sessionStorage } from './sessionStorage';
import { SessionIndex } from './sessionSearch';
import { UsageIndex, type UsageRequest } from './sessionUsage';

const data = workerData as { projectsDir: string; tagsFile: string; ledgerFile: string };
const index = new SessionIndex(data.projectsDir);
const usage = new UsageIndex(data.projectsDir, data.tagsFile, data.ledgerFile);

type WorkerRequest =
  | { id: number; kind: 'search'; request: SessionSearchRequest }
  | { id: number; kind: 'usage'; request: UsageRequest }
  | { id: number; kind: 'transcript'; request: FullTranscriptRequest }
  | { id: number; kind: 'storage'; request: undefined };

function answer(message: WorkerRequest): Promise<unknown> {
  switch (message.kind) {
    case 'search':
      return index.search(message.request);
    case 'usage':
      return usage.answer(message.request);
    case 'transcript':
      return writeFullTranscript(data.projectsDir, message.request);
    case 'storage':
      return sessionStorage(data.projectsDir);
  }
}

parentPort?.on('message', (message: WorkerRequest) => {
  answer(message).then(
    (result) => parentPort?.postMessage({ id: message.id, result }),
    (error: unknown) => parentPort?.postMessage({ id: message.id, error: String(error) }),
  );
});
