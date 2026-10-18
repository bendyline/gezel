/**
 * Worker-thread host for embedding inference. Runs the transformers.js /
 * onnxruntime pipeline OFF the Electron main thread so the synchronous native
 * `InferenceSession.Run` — which used to execute on `CrBrowserMain` and, on a
 * large allocation, trapped and killed the whole app — now executes here. A
 * long enrichment batch also no longer janks the UI.
 *
 * Protocol (structured-clone messages over the worker port):
 *   host → worker:  { id, texts, profile?,          — profile: embed as a
 *                     reportProgress? }               knowledge-catalog QUERY
 *                                                     with that profile;
 *                                                     reportProgress: send the
 *                                                     model download's bytes
 *                   { cancel: true }                — shutdown: stop the
 *                                                     download and runs in flight
 *   worker → host:  { id, progress }                — interim, zero or more
 *                   { id, vectors }                 — success
 *                   { id, error, fatal,             — failure (fatal ⇒ model
 *                     retryable, optionalPeerMissing, unloadable, disable for
 *                     cancelled }                     good; optionalPeerMissing
 *                                                     ⇒ the peer is just not
 *                                                     installed; retryable ⇒ a
 *                                                     short host-side cooldown;
 *                                                     cancelled ⇒ stopped by a
 *                                                     cancel, not a fault)
 */

import { parentPort } from 'node:worker_threads';
import type { KnowledgeEmbeddingProfile } from '@bendyline/gezel';
import {
  ModelWorkCancelledError,
  PipelineLoadError,
  cancelInFlightModelWork,
  runEmbed,
  runProfileQueryEmbed,
} from './embed-core.js';

if (!parentPort) {
  throw new Error('embed-worker must be run as a worker thread');
}
const port = parentPort;

interface EmbedRequest {
  id: number;
  texts: string[];
  profile?: KnowledgeEmbeddingProfile;
  reportProgress?: boolean;
  localFilesOnly?: boolean;
}

/** Sent by the host at shutdown; each request it stops answers with `cancelled`. */
interface CancelRequest {
  cancel: true;
}

port.on('message', (msg: EmbedRequest | CancelRequest) => {
  if ('cancel' in msg) {
    cancelInFlightModelWork();
    return;
  }
  void (async () => {
    try {
      const vectors = msg.profile
        ? await runProfileQueryEmbed(
            msg.texts,
            msg.profile,
            msg.reportProgress
              ? (progress) => port.postMessage({ id: msg.id, progress })
              : undefined,
            msg.localFilesOnly,
          )
        : await runEmbed(msg.texts);
      port.postMessage({ id: msg.id, vectors });
    } catch (err) {
      port.postMessage({
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
        fatal: err instanceof PipelineLoadError && !err.retryable,
        retryable: err instanceof PipelineLoadError && err.retryable,
        optionalPeerMissing: err instanceof PipelineLoadError && err.optionalPeerMissing,
        cancelled: err instanceof ModelWorkCancelledError,
      });
    }
  })();
});
