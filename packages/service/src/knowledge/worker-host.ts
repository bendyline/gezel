/**
 * Worker-backed KnowledgeCatalogHost — the daemon's production host. Spawns
 * the knowledge search-worker (embed-worker spawn pattern: long-lived,
 * unref'd, id-correlated request/response, reject-in-flight on death, crash
 * cap → permanent in-process fallback). Under vitest there is no dist
 * build, so the in-process host is used directly.
 */

import { Worker } from 'node:worker_threads';
import { createLogger } from '@bendyline/gezel';
import { findServiceWorkerEntry } from '../utils/service-worker-entry.js';
import { type KnowledgeCatalogHost, createInProcessCatalogHost } from './catalog-host.js';

const log = createLogger('knowledge');

const CRASH_CAP = 3;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export function createWorkerCatalogHost(): KnowledgeCatalogHost {
  let worker: Worker | null = null;
  let workerUsable = !process.env.VITEST;
  let crashCount = 0;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let fallbackPromise: Promise<KnowledgeCatalogHost> | null = null;
  /** Mounts replayed into a fresh worker (or the fallback) after a crash. */
  const mounts = new Map<string, unknown>();

  const fallback = (): Promise<KnowledgeCatalogHost> => {
    fallbackPromise ??= (async () => {
      const host = await createInProcessCatalogHost();
      for (const spec of mounts.values()) {
        // biome-ignore lint/suspicious/noExplicitAny: replaying recorded mount specs
        await host.mount(spec as any).catch((err) => {
          log.warn(`fallback remount failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      return host;
    })();
    return fallbackPromise;
  };

  const onWorkerDown = (reason: string): void => {
    const dead = worker;
    worker = null;
    if (dead) void dead.terminate().catch(() => {});
    const inflight = [...pending.values()];
    pending.clear();
    for (const p of inflight) p.reject(new Error(`knowledge worker stopped: ${reason}`));
    crashCount++;
    if (crashCount >= CRASH_CAP) {
      workerUsable = false;
      log.warn(`knowledge worker crashed ${crashCount} times; catalog queries run in-process now`);
    }
  };

  const ensureWorker = (): Worker | null => {
    if (!workerUsable) return null;
    if (worker) return worker;
    const entry = findServiceWorkerEntry(import.meta.url, 'knowledge');
    if (!entry) {
      workerUsable = false;
      return null;
    }
    try {
      const w = new Worker(entry);
      w.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error !== undefined) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      });
      w.on('error', (err) => onWorkerDown(err instanceof Error ? err.message : String(err)));
      w.on('exit', (code) => {
        if (code !== 0) onWorkerDown(`worker exited with code ${code}`);
      });
      w.unref();
      worker = w;
      // Replay mounts into the fresh worker so a crash is invisible to
      // callers beyond the requests that died with it.
      for (const spec of mounts.values()) {
        void call('mount', [spec]).catch(() => {});
      }
      return w;
    } catch (err) {
      log.warn(
        `knowledge worker failed to start; using in-process host: ${err instanceof Error ? err.message : String(err)}`,
      );
      workerUsable = false;
      return null;
    }
  };

  const call = async (op: string, args: unknown[]): Promise<unknown> => {
    const w = ensureWorker();
    if (!w) {
      const host = await fallback();
      // biome-ignore lint/suspicious/noExplicitAny: op-indexed dispatch mirrors the worker protocol
      return (host[op as keyof KnowledgeCatalogHost] as any)(...args);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, op, args });
    });
  };

  return {
    mount: async (spec) => {
      mounts.set(spec.key, spec);
      try {
        await call('mount', [spec]);
      } catch (err) {
        mounts.delete(spec.key);
        throw err;
      }
    },
    unmount: async (key) => {
      mounts.delete(key);
      await call('unmount', [key]);
    },
    mounted: async () => (await call('mounted', [])) as string[],
    validate: async (rootDir, deep) =>
      // biome-ignore lint/suspicious/noExplicitAny: worker returns the structured report verbatim
      (await call('validate', [rootDir, deep])) as any,
    topics: async (key) =>
      // biome-ignore lint/suspicious/noExplicitAny: structured-clone round trip preserves the shape
      (await call('topics', [key])) as any,
    documentsPage: async (key, opts) =>
      // biome-ignore lint/suspicious/noExplicitAny: structured-clone round trip preserves the shape
      (await call('documentsPage', [key, opts])) as any,
    getDocument: async (key, documentId) =>
      // biome-ignore lint/suspicious/noExplicitAny: structured-clone round trip preserves the shape
      (await call('getDocument', [key, documentId])) as any,
    search: async (request) =>
      // biome-ignore lint/suspicious/noExplicitAny: structured-clone round trip preserves the shape
      (await call('search', [request])) as any,
    dispose: async () => {
      const w = worker;
      worker = null;
      pending.clear();
      if (w) {
        try {
          await w.terminate();
        } catch {
          /* already gone */
        }
      }
      if (fallbackPromise) await (await fallbackPromise).dispose();
    },
  };
}
