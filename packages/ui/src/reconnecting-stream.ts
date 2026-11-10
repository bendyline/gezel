export interface ReconnectingStreamOptions {
  signal: AbortSignal;
  /**
   * Runs each time the stream opens again after it failed or ended. Events
   * sent while it was down are gone, so the caller re-reads what they would
   * have changed.
   */
  onReconnect?: () => void;
  /** Reports a failure before the next attempt. */
  onError?: (error: unknown, retryInMs: number) => void;
  minDelayMs?: number;
  maxDelayMs?: number;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * An app-lifetime event stream that opens again after it fails or ends.
 * A stalled daemon (a model loading, the machine paging) trips the stream's
 * keepalive and ends it; a listener that stopped there missed every later
 * event, so a project created minutes afterwards never reached the rail.
 */
export async function* reconnectingStream<T>(
  open: (signal: AbortSignal) => AsyncIterable<T>,
  opts: ReconnectingStreamOptions,
): AsyncGenerator<T> {
  const minDelayMs = opts.minDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  let delayMs = minDelayMs;
  let opened = false;
  while (!opts.signal.aborted) {
    if (opened) opts.onReconnect?.();
    opened = true;
    try {
      for await (const item of open(opts.signal)) {
        delayMs = minDelayMs;
        yield item;
      }
    } catch (error) {
      if (opts.signal.aborted) return;
      opts.onError?.(error, delayMs);
    }
    if (opts.signal.aborted) return;
    await wait(delayMs, opts.signal);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}
