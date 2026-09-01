const REMOTE_BACKPRESSURE_INITIAL_MS = 250;
const REMOTE_BACKPRESSURE_MAX_MS = 2_000;

/** The broker's defensive admission response for ordinary queue pressure. */
export function isTenantConcurrencyResponse(status: number, detail: string): boolean {
  if (status !== 429) return false;
  try {
    return (JSON.parse(detail) as { error?: string }).error === 'tenant_concurrency_exceeded';
  } catch {
    return false;
  }
}

/**
 * A model swap reached a resident engine that is still serving a turn. This
 * is queue pressure, not a failed turn: callers wait and retry the same
 * stateless request after the broker's bounded drain attempt returns.
 */
export function isEngineBusyResponse(status: number, detail: string): boolean {
  if (status !== 503) return false;
  try {
    return (JSON.parse(detail) as { error?: string }).error === 'engine_busy';
  } catch {
    return false;
  }
}

/** Honor the broker's Retry-After hint, with a bounded mixed-version fallback. */
export function remoteBackpressureDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  }
  return Math.min(
    REMOTE_BACKPRESSURE_MAX_MS,
    REMOTE_BACKPRESSURE_INITIAL_MS * 2 ** Math.max(0, attempt),
  );
}

/** Abort-aware queue wait shared by admission and inference requests. */
export async function waitForRemoteCapacity(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted', 'AbortError'),
      );
    };
    function finish() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    // Abort may have landed between the fast-path check above and listener
    // registration. AbortSignal does not replay that event to late listeners.
    if (signal?.aborted) onAbort();
  });
}
