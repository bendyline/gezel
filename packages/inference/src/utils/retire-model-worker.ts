import type { Worker } from 'node:worker_threads';

/** How long shutdown waits for a model worker's in-flight work. */
export const MODEL_WORKER_DRAIN_MS = 5_000;

/**
 * Terminate a model worker without aborting the process.
 *
 * Tearing down a thread while onnxruntime is running in it — or while it is
 * still loading onnxruntime's native addon for its first request — aborts the
 * whole process ("terminating due to uncaught exception of type Napi::Error").
 * `process.exit` tears down every live worker, so shutdown must terminate model
 * workers itself, and only once they are idle. Waits up to `drainMs` for
 * `isIdle()`; returns false, leaving the worker running, if it never gets
 * there.
 */
export async function retireModelWorker(
  worker: Worker,
  isIdle: () => boolean,
  drainMs: number,
): Promise<boolean> {
  const deadline = Date.now() + drainMs;
  while (!isIdle()) {
    if (Date.now() >= deadline) return false;
    // Not unref'd: an idle event loop would exit and tear the worker down.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await worker.terminate().catch(() => {});
  return true;
}
