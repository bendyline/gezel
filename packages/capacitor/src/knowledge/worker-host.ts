/// <reference lib="dom" />
import type { KnowledgeCatalogHost } from '@bendyline/gezel-inference/internal/knowledge/catalog-host';

export interface KnowledgeWorkerUrls {
  /** `knowledge-worker.js` from this package, served by the app. */
  workerUrl: string | URL;
  /** `sqlite3.wasm` from this package, served by the app. */
  wasmUrl: string | URL;
}

type Op = keyof KnowledgeCatalogHost;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

/**
 * The catalog host of inference/src/knowledge/catalog-host.ts, run in a Web
 * Worker: its SQLite reads are synchronous range requests, which only a worker
 * may make, and a scan must not stall the editor. Starts on first use.
 */
export function createWorkerCatalogHost(
  urls: KnowledgeWorkerUrls,
  baseUrl: () => Promise<string>,
): KnowledgeCatalogHost & { terminate(): void } {
  let worker: Worker | undefined;
  let ready: Promise<void> | undefined;
  let next = 0;
  const pending = new Map<number, Pending>();
  const fail = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const start = (): Promise<void> => {
    ready ??= (async () => {
      const base = await baseUrl();
      const created = new Worker(urls.workerUrl, { type: 'module' });
      worker = created;
      created.onmessage = ({
        data,
      }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
        const waiter = pending.get(data.id);
        if (!waiter) return;
        pending.delete(data.id);
        if (data.error !== undefined) waiter.reject(new Error(data.error));
        else waiter.resolve(data.result);
      };
      created.onerror = (event) => {
        fail(new Error(event.message || 'The knowledge worker stopped'));
        worker = undefined;
        ready = undefined;
      };
      await send('init' as Op, [{ baseUrl: base, wasmUrl: String(urls.wasmUrl) }]);
    })().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
  function send(op: Op, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      worker!.postMessage({ id, op, args });
    });
  }
  const call =
    (op: Op) =>
    async (...args: unknown[]) => {
      await start();
      return send(op, args);
    };
  const host = Object.fromEntries(
    (
      [
        'mount',
        'unmount',
        'mounted',
        'prewarm',
        'validate',
        'topics',
        'documentsPage',
        'documentInitials',
        'documentPosition',
        'nearbyDocuments',
        'getDocument',
        'getChunk',
        'assets',
        'readAsset',
        'assetFile',
        'search',
      ] as const
    ).map((op) => [op, call(op)]),
  ) as unknown as KnowledgeCatalogHost;
  return Object.assign(host, {
    async dispose() {
      if (worker) await send('dispose', []).catch(() => undefined);
    },
    terminate() {
      worker?.terminate();
      worker = undefined;
      ready = undefined;
      fail(new Error('The knowledge worker was stopped'));
    },
  });
}
