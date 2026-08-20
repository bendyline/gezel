/**
 * Worker-thread host for IMAGE embedding inference — the sibling of
 * embed-worker.ts, deliberately a separate worker: one modality's model,
 * memory budget, and crash accounting must never bleed into the other's (an
 * image-model failure pushing TEXT search to degraded was the failure mode a
 * shared worker would invite). Decode also happens here, worker-side — a
 * 12 MP JPEG costs 100+ ms CPU and a ~48 MB RGBA transient, exactly the work
 * the worker exists to keep off the Electron main thread.
 *
 * Protocol (structured-clone messages over the worker port):
 *   host → worker:  { id, kind: 'clip', images: [{ path, hash }] }
 *   worker → host:  { id, results }                — per-image outcomes as
 *                                                    DATA (vector | terminal
 *                                                    skip | retryable error)
 *                   { id, error, fatal,            — pipeline-level failure
 *                     retryable, optionalPeerMissing } (same classification
 *                                                    as embed-worker)
 *
 * `kind` is a forward-compat discriminator: the face lane ('faces') runs its
 * ONNX sessions in this same worker so one thread owns all image decode.
 */

import { parentPort } from 'node:worker_threads';
import { PipelineLoadError } from './embed-core.js';
import { type FaceModelPaths, runFaceDetect } from './face-embed-core.js';
import { type ImageEmbedJob, runImageEmbed } from './image-embed-core.js';

if (!parentPort) {
  throw new Error('image-embed-worker must be run as a worker thread');
}
const port = parentPort;

type ImageEmbedRequest =
  | { id: number; kind: 'clip'; images: ImageEmbedJob[] }
  | { id: number; kind: 'faces'; images: ImageEmbedJob[]; models: FaceModelPaths };

port.on('message', (msg: ImageEmbedRequest) => {
  void (async () => {
    try {
      const results =
        msg.kind === 'faces'
          ? await runFaceDetect(msg.images, msg.models)
          : await runImageEmbed(msg.images);
      port.postMessage({ id: msg.id, results });
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
