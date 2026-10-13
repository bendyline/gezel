/**
 * Worker-thread host for relevance-model inference. Its own worker, not the
 * text-embedding one: ONNX runs synchronously and would stall `embedQuery`
 * for the titlebar search, and a relevance-model crash must never count
 * toward the embed worker's crash limit (three crashes there move all text
 * embedding onto the main thread for good).
 *
 * Protocol (structured clone over the worker port):
 *   host → worker: { id, kind: 'warm', model }
 *                  { id, kind: 'score', model, query, passages, deadlineAt }
 *                  { id, kind: 'dispose' }
 *   worker → host: { id, ok: true }                         (warm, dispose)
 *                  { id, scores, partial, truncatedPassages, inferMs }
 *                  { id, expired: true }                     (deadline passed in the queue)
 *                  { id, error, fatal, retryable }
 *
 * One ONNX run at a time: requests queue FIFO, and a request whose deadline
 * passed while it waited is answered `expired` without running.
 */

import { parentPort } from 'node:worker_threads';
import { PipelineLoadError } from '../memory/embed-core.js';
import {
  type ResolvedRelevanceModel,
  disposeRelevanceModels,
  loadRelevanceModel,
  scoreRelevancePairs,
} from './relevance-core.js';

if (!parentPort) throw new Error('relevance-worker must be run as a worker thread');
const port = parentPort;

type Request =
  | { id: number; kind: 'warm'; model: ResolvedRelevanceModel }
  | {
      id: number;
      kind: 'score';
      model: ResolvedRelevanceModel;
      query: string;
      passages: string[];
      deadlineAt?: number;
    }
  | { id: number; kind: 'dispose' };

let queue: Promise<void> = Promise.resolve();

port.on('message', (msg: Request) => {
  queue = queue.then(() => handle(msg));
});

async function handle(msg: Request): Promise<void> {
  try {
    if (msg.kind === 'dispose') {
      disposeRelevanceModels();
      port.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.kind === 'warm') {
      await loadRelevanceModel(msg.model);
      port.postMessage({ id: msg.id, ok: true });
      return;
    }
    if (msg.deadlineAt !== undefined && Date.now() > msg.deadlineAt) {
      port.postMessage({ id: msg.id, expired: true });
      return;
    }
    const outcome = await scoreRelevancePairs(msg.model, msg.query, msg.passages, msg.deadlineAt);
    port.postMessage({ id: msg.id, ...outcome });
  } catch (err) {
    port.postMessage({
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
      fatal: err instanceof PipelineLoadError && !err.retryable,
      retryable: err instanceof PipelineLoadError && err.retryable,
    });
  }
}
