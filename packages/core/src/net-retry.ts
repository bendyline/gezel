/**
 * Transient-network retry primitives, shared by every code path that pulls
 * bytes off the internet.
 *
 * There are two shapes of network work in gezel and they need different
 * treatment:
 *
 *   1. **Multi-GB resumable transfers** (model weights, engine archives).
 *      Those go through the service's `downloadWithRetry` helper, which
 *      layers HTTP Range resumption and a progress-aware attempt budget on
 *      top of the primitives here.
 *   2. **The small requests that surround a big transfer** — GitHub release
 *      metadata, SHA256SUMS manifests, npm packuments, sub-100 MiB tarballs.
 *      Historically these had *no* retry at all, so one dropped packet
 *      during first-run setup failed the whole install with a raw
 *      `fetch failed`. `retryTransient` is for those.
 *
 * Both share one backoff schedule and one notion of "is this error worth
 * retrying", so a flaky link produces consistent behavior everywhere.
 */

/**
 * Backoff schedule (ms), indexed by 0-based retry number. Jitter is applied
 * on top so concurrent transfers don't retry in lockstep and re-collide.
 */
export const DEFAULT_BACKOFF_SCHEDULE_MS: readonly number[] = [1_000, 2_000, 4_000, 6_000, 8_000];

/** Default attempt count for the small-request helper. 3 attempts = 2 retries. */
export const DEFAULT_TRANSIENT_ATTEMPTS = 3;

export function backoffDelayMs(
  retryIndex: number,
  schedule: readonly number[] = DEFAULT_BACKOFF_SCHEDULE_MS,
  random: () => number = Math.random,
): number {
  const base = schedule[Math.min(Math.max(retryIndex, 0), schedule.length - 1)] ?? 8_000;
  const jitter = base * (random() * 0.4 - 0.2);
  return Math.round(base + jitter);
}

/** Resolves `true` when the wait was cut short by an abort. */
export async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A non-2xx response, thrown so `retryTransient` can decide retryability from
 * the status code. Callers that want a friendlier message pass one in.
 */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

/**
 * 5xx, 408, and 429 are the server telling us to come back. Everything else in
 * 4xx is a real client-side problem (missing asset, gated repo, bad auth) and
 * retrying just delays an unavoidable error.
 */
export function isTransientHttpStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Undici surfaces network faults as `TypeError: fetch failed` with the real
 * errno on `.cause`, so match against the flattened chain rather than
 * `err.code`. Aborts are deliberately NOT transient — a cancel means stop.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof HttpStatusError) return isTransientHttpStatus(err.status);
  const raw = flattenErrorMessage(err);
  if (/AbortError|The operation was aborted|This operation was aborted/i.test(raw)) return false;
  return /fetch failed|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAGAIN|socket hang up|premature close|terminated|UND_ERR_|timed out|network/i.test(
    raw,
  );
}

/** Error name + message + the whole `cause` chain, for pattern matching. */
export function flattenErrorMessage(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = err;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string') parts.push(code);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' | ');
}

export interface RetryAttemptInfo {
  /** Which attempt is about to start (1-based). */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  /** Flattened message of the failure that triggered this retry. */
  reason: string;
}

export interface RetryTransientOptions {
  /** Total attempts, not retries. Default 3. */
  attempts?: number;
  /** Short human label used in the give-up message, e.g. 'release metadata'. */
  label?: string;
  signal?: AbortSignal;
  /** Override which errors are worth retrying. Default: `isTransientNetworkError`. */
  isRetryable?: (err: unknown) => boolean;
  /** Notified before each wait, for progress plumbing / logging. */
  onRetry?: (info: RetryAttemptInfo) => void;
  schedule?: readonly number[];
}

/**
 * Run `fn`, retrying transient network failures with exponential backoff.
 * Non-transient failures (4xx, programming errors, aborts) rethrow on the
 * first try — retrying them would only add latency to a certain failure.
 */
export async function retryTransient<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryTransientOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, opts.attempts ?? DEFAULT_TRANSIENT_ATTEMPTS);
  const isRetryable = opts.isRetryable ?? isTransientNetworkError;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('request was cancelled');
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || opts.signal?.aborted || !isRetryable(err)) throw err;
      const delayMs = backoffDelayMs(attempt - 1, opts.schedule);
      opts.onRetry?.({
        attempt: attempt + 1,
        maxAttempts,
        delayMs,
        reason: flattenErrorMessage(err),
      });
      if (await sleepWithAbort(delayMs, opts.signal)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * `retryTransient` around a single `fetch`, with non-retryable statuses
 * rejected as `HttpStatusError` so callers get one uniform error type.
 * The response body is left unread — the caller owns it.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit & { fetchImpl?: typeof fetch } = {},
  opts: RetryTransientOptions = {},
): Promise<Response> {
  const { fetchImpl, ...requestInit } = init;
  const doFetch = fetchImpl ?? globalThis.fetch;
  return retryTransient(async () => {
    const res = await doFetch(url, requestInit);
    if (!res.ok) {
      // Drain so undici can release the socket before we retry or throw.
      await res.body?.cancel().catch(() => {});
      throw new HttpStatusError(res.status, `${opts.label ?? url}: HTTP ${res.status}`);
    }
    return res;
  }, opts);
}
