import { Worker } from 'node:worker_threads';
import { createLogger } from '@bendyline/gezel';
import { findServiceWorkerEntry } from '../utils/service-worker-entry.js';
import { type ContentIndexStats, indexWorkspaceContent } from './content-indexer.js';
import { IndexStore } from './index-store.js';

const log = createLogger('index:static-worker');

export interface StaticIndexRequest {
  dbPath: string;
  workspaceDir: string;
  collectionId: string;
}

interface WorkerRequest extends StaticIndexRequest {
  id: number;
}

interface WorkerReply {
  id: number;
  stats?: ContentIndexStats;
  error?: string;
}

interface PendingRequest {
  resolve: (stats: ContentIndexStats) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();

/**
 * Run the deterministic file/classification/symbol/SQLite tier away from the
 * service event loop. In embedded dev mode that event loop is Electron's main
 * thread, so an in-process repository refresh freezes window chrome and IPC.
 *
 * Vitest deliberately uses the direct path: its source tree has no built
 * worker entry, while production and `pnpm app` both consume `dist/`, where
 * tsup guarantees the worker is staged as a sibling entry.
 */
export async function runStaticIndex(request: StaticIndexRequest): Promise<ContentIndexStats> {
  if (process.env.VITEST) return runStaticIndexInProcess(request);
  const target = ensureWorker();
  if (!target) {
    throw new Error(
      'static index worker is missing; rebuild @bendyline/gezel-service before starting the daemon',
    );
  }
  const id = nextId++;
  return new Promise<ContentIndexStats>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ id, ...request } satisfies WorkerRequest);
  });
}

async function runStaticIndexInProcess(request: StaticIndexRequest): Promise<ContentIndexStats> {
  const index = await IndexStore.open(request.dbPath, {
    collectionId: request.collectionId,
    kind: 'workspace',
    rootPath: request.workspaceDir,
  });
  if (!index) throw new Error(`content index unavailable at ${request.dbPath}`);
  try {
    return await indexWorkspaceContent(index, request.workspaceDir);
  } finally {
    index.close();
  }
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  const entry = workerEntry();
  if (!entry) return null;
  try {
    const next = new Worker(entry);
    next.on('message', onMessage);
    next.on('error', (error) => onWorkerDown(error.message));
    next.on('exit', (code) => {
      if (code !== 0) onWorkerDown(`worker exited with code ${code}`);
      else if (worker === next) worker = null;
    });
    next.unref();
    worker = next;
    return next;
  } catch (error) {
    log.error(`failed to start static index worker: ${describe(error)}`);
    return null;
  }
}

function workerEntry(): string | null {
  return findServiceWorkerEntry(import.meta.url, 'static-index');
}

function onMessage(reply: WorkerReply): void {
  const request = pending.get(reply.id);
  if (!request) return;
  pending.delete(reply.id);
  if (reply.error) request.reject(new Error(reply.error));
  else if (reply.stats) request.resolve(reply.stats);
  else request.reject(new Error('static index worker returned no result'));
}

function onWorkerDown(reason: string): void {
  const dead = worker;
  worker = null;
  if (dead) void dead.terminate().catch(() => {});
  const error = new Error(`static index worker stopped: ${reason}`);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
