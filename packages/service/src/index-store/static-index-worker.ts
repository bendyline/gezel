/**
 * Worker-thread host for deterministic workspace content indexing.
 *
 * The worker serializes requests because tree-sitter and synchronous SQLite
 * both benefit from one bounded writer. The parent service remains available
 * for UI/API traffic while a large repository refresh is in flight.
 */

import { parentPort } from 'node:worker_threads';
import { indexWorkspaceContent } from './content-indexer.js';
import { IndexStore } from './index-store.js';

if (!parentPort) throw new Error('static-index-worker must be run as a worker thread');
const port = parentPort;

interface StaticIndexWorkerRequest {
  id: number;
  dbPath: string;
  workspaceDir: string;
  collectionId: string;
}

let chain: Promise<void> = Promise.resolve();

port.on('message', (request: StaticIndexWorkerRequest) => {
  const run = async (): Promise<void> => {
    try {
      const index = await IndexStore.open(request.dbPath, {
        collectionId: request.collectionId,
        kind: 'workspace',
        rootPath: request.workspaceDir,
      });
      if (!index) throw new Error(`content index unavailable at ${request.dbPath}`);
      try {
        const stats = await indexWorkspaceContent(index, request.workspaceDir);
        port.postMessage({ id: request.id, stats });
      } finally {
        index.close();
      }
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  chain = chain.then(run, run);
});
