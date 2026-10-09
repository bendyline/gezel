/**
 * Run deferred boot work once, unless the service has begun stopping, and
 * return its cancellation for `stop()`.
 *
 * The embedding warm-up fires 20 s after boot. A daemon stopped just before
 * then (Settings restarting it) began shutdown, the warm-up started an embed
 * worker, and `process.exit` tore that worker down while it was loading
 * onnxruntime — an uncatchable abort ("terminating due to uncaught exception
 * of type Napi::Error", SIGABRT) reported as a Gezel crash.
 */
export function deferBootWork(
  delayMs: number,
  work: () => void,
  isStopping: () => boolean,
): () => void {
  const timer = setTimeout(() => {
    if (!isStopping()) work();
  }, delayMs);
  // Deferred, best-effort work never holds the process open.
  timer.unref();
  return () => clearTimeout(timer);
}
