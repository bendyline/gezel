/**
 * Knowledge catalog worker — owns every catalog SQLite connection.
 * CatalogHandle is synchronous by design (node:sqlite), so a 10-20 ms shard
 * scan (or a 100 ms cold burst) must run here, never on the daemon loop
 * (docs/gezk-format.md). One long-lived worker; scans run sequentially
 * inside it, which is the format's stated concurrency model.
 *
 * Protocol (structured-clone messages over the worker port):
 *   host → worker:  { id, op, ...args }   — one op per KnowledgeCatalogHost method
 *   worker → host:  { id, result }        — success
 *                   { id, error }         — failure (message string)
 */

import { parentPort } from 'node:worker_threads';
import { type KnowledgeCatalogHost, createInProcessCatalogHost } from './catalog-host.js';

if (!parentPort) {
  throw new Error('knowledge search-worker must be run as a worker thread');
}
const port = parentPort;

export interface KnowledgeWorkerRequest {
  id: number;
  op:
    | 'mount'
    | 'unmount'
    | 'mounted'
    | 'validate'
    | 'topics'
    | 'documentsPage'
    | 'getDocument'
    | 'assets'
    | 'readAsset'
    | 'search'
    | 'dispose';
  args: unknown[];
}

let hostPromise: Promise<KnowledgeCatalogHost> | null = null;
function host(): Promise<KnowledgeCatalogHost> {
  hostPromise ??= createInProcessCatalogHost();
  return hostPromise;
}

port.on('message', (msg: KnowledgeWorkerRequest) => {
  void (async () => {
    try {
      const h = await host();
      // biome-ignore lint/suspicious/noExplicitAny: op-indexed dynamic dispatch over the host interface
      const result = await (h[msg.op] as any)(...msg.args);
      port.postMessage({ id: msg.id, result });
    } catch (err) {
      port.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});
