import {
  openEmbeddings,
  shutdownEmbeddings,
} from '@bendyline/gezel-inference/internal/memory/embeddings';
import {
  openRelevanceScorer,
  shutdownRelevanceScorer,
} from '@bendyline/gezel-inference/internal/relevance/relevance-model';
import { MODEL_WORKER_DRAIN_MS } from '@bendyline/gezel-inference/internal/utils/retire-model-worker';
import { openImageEmbeddings, shutdownImageEmbeddings } from './memory/image-embeddings.js';

/**
 * The process-wide onnxruntime worker hosts: text embeddings, image and media
 * embeddings, and the relevance model. They are singletons shared by whichever
 * service runs in this process — one at a time.
 */

/** Accept model work. Called as a service starts: an embedded one can restart in-process. */
export function openModelWorkers(): void {
  openEmbeddings();
  openImageEmbeddings();
  openRelevanceScorer();
}

/**
 * Refuse new model work and terminate each worker once its in-flight work has
 * finished. Never mid-run: tearing down a worker inside onnxruntime aborts the
 * process, which is how a daemon restart used to end in a crash report.
 */
export async function shutdownModelWorkers(drainMs = MODEL_WORKER_DRAIN_MS): Promise<void> {
  await Promise.all([
    shutdownEmbeddings(drainMs),
    shutdownImageEmbeddings(drainMs),
    shutdownRelevanceScorer(drainMs),
  ]);
}
