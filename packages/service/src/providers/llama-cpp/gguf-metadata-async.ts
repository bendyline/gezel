import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createLogger } from '@bendyline/gezel';
import { findServiceWorkerEntry } from '../../utils/service-worker-entry.js';
import { type GgufSummary, readGgufSummary } from './gguf-metadata.js';

const log = createLogger('gguf:metadata-worker');
const MAX_CACHE_ENTRIES = 32;

export interface GgufSummaryOptions {
  includeTensors?: boolean;
  includeTensorSizes?: boolean;
}

interface WorkerReply {
  id: number;
  summary?: GgufSummary;
  error?: string;
}

interface PendingRequest {
  resolve: (summary: GgufSummary) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();
const cache = new Map<string, GgufSummary>();
const inFlight = new Map<string, Promise<GgufSummary>>();

/**
 * Inspect a GGUF without blocking the daemon event loop. Results are keyed by
 * file identity and option set, so Settings' model-list polling only parses a
 * given installed payload once and a replaced model invalidates naturally.
 */
export async function readGgufSummaryAsync(
  path: string,
  options?: GgufSummaryOptions,
): Promise<GgufSummary> {
  const info = await stat(path);
  const key = [
    resolve(path),
    info.size,
    info.mtimeMs,
    options?.includeTensors === true ? 1 : 0,
    options?.includeTensorSizes === true ? 1 : 0,
  ].join('\n');
  const cached = cache.get(key);
  if (cached) return cached;
  const active = inFlight.get(key);
  if (active) return active;

  const request = runInWorker(path, options).then((summary) => {
    cache.set(key, summary);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return summary;
  });
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key);
  }
}

async function runInWorker(path: string, options?: GgufSummaryOptions): Promise<GgufSummary> {
  // Vitest runs the TS source tree without emitted worker entries. Keep its
  // synthetic fixtures simple and deterministic; production builds must ship
  // the worker and fail this advisory preview if packaging regresses.
  if (process.env.VITEST) return readGgufSummary(path, options);
  const target = ensureWorker();
  if (!target) {
    throw new Error(
      'GGUF metadata worker is missing; rebuild @bendyline/gezel-service before starting the daemon',
    );
  }
  const id = nextId++;
  return new Promise<GgufSummary>((resolveSummary, reject) => {
    pending.set(id, { resolve: resolveSummary, reject });
    target.postMessage({ id, path, ...(options ? { options } : {}) });
  });
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
    log.error(`failed to start GGUF metadata worker: ${describe(error)}`);
    return null;
  }
}

function workerEntry(): string | null {
  return findServiceWorkerEntry(import.meta.url, 'gguf-metadata');
}

function onMessage(reply: WorkerReply): void {
  const request = pending.get(reply.id);
  if (!request) return;
  pending.delete(reply.id);
  if (reply.error) request.reject(new Error(reply.error));
  else if (reply.summary) request.resolve(reply.summary);
  else request.reject(new Error('GGUF metadata worker returned no summary'));
}

function onWorkerDown(reason: string): void {
  const dead = worker;
  worker = null;
  if (dead) void dead.terminate().catch(() => {});
  const error = new Error(`GGUF metadata worker stopped: ${reason}`);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
