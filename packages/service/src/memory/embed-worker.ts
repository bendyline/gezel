/**
 * Worker-thread host for embedding inference. Runs the transformers.js /
 * onnxruntime pipeline OFF the Electron main thread so the synchronous native
 * `InferenceSession.Run` — which used to execute on `CrBrowserMain` and, on a
 * large allocation, trapped and killed the whole app — now executes here. A
 * long enrichment batch also no longer janks the UI.
 *
 * Protocol (structured-clone messages over the worker port):
 *   host → worker:  { id, texts }
 *   worker → host:  { id, vectors }                 — success
 *                   { id, error, fatal,             — failure (fatal ⇒ model
 *                     retryable, optionalPeerMissing } unloadable, disable for
 *                                                     good; optionalPeerMissing
 *                                                     ⇒ the peer is just not
 *                                                     installed; retryable ⇒ a
 *                                                     short host-side cooldown)
 */

import { parentPort } from 'node:worker_threads';
import { PipelineLoadError, runEmbed } from './embed-core.js';

if (!parentPort) {
  throw new Error('embed-worker must be run as a worker thread');
}
const port = parentPort;

interface EmbedRequest {
  id: number;
  texts: string[];
}

port.on('message', (msg: EmbedRequest) => {
  void (async () => {
    try {
      const vectors = await runEmbed(msg.texts);
      port.postMessage({ id: msg.id, vectors });
    } catch (err) {
      port.postMessage({
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
        fatal: err instanceof PipelineLoadError && !err.retryable,
        retryable: err instanceof PipelineLoadError && err.retryable,
        optionalPeerMissing: err instanceof PipelineLoadError && err.optionalPeerMissing,
      });
    }
  })();
});
