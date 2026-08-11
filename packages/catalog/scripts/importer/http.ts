/**
 * Tiny HTTP wrapper used by every network-touching importer module.
 * Adds: a polite User-Agent, automatic exponential backoff on 429 /
 * 5xx, and an optional Authorization header. Returns the raw
 * `Response` so callers decide how to consume the body.
 */

const USER_AGENT = 'gezel-catalog-importer/0.1 (+https://github.com/bendyline/gezel)';

export interface FetchWithRetryOptions {
  /** Per-call max retries on 429/5xx. */
  maxRetries?: number;
  /** Initial backoff in ms; doubles each retry, ±20% jitter. */
  baseDelayMs?: number;
  /** Optional bearer token. */
  token?: string;
  /** Extra headers to merge in. */
  headers?: Record<string, string>;
  /** Set true to throw on any non-2xx response after retries. */
  throwOnError?: boolean;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelay = opts.baseDelayMs ?? 500;
  const headers = new Headers(init.headers);
  headers.set('User-Agent', USER_AGENT);
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { ...init, headers });
      if (res.status === 429 || isRateLimited403(res) || (res.status >= 500 && res.status < 600)) {
        if (attempt >= maxRetries) {
          if (opts.throwOnError) {
            const body = await safeReadBody(res);
            throw new HttpError(res.status, url, body);
          }
          return res;
        }
        await sleep(jittered(baseDelay * 2 ** attempt));
        continue;
      }
      if (!res.ok && opts.throwOnError) {
        const body = await safeReadBody(res);
        throw new HttpError(res.status, url, body);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError) throw err;
      if (attempt >= maxRetries) throw err;
      await sleep(jittered(baseDelay * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`fetch failed: ${url}`);
}

/**
 * GitHub reports throttling as `403` with the rate-limit budget
 * exhausted, not `429`. Without this the retry ladder skips it
 * entirely and the caller reads a temporary throttle as a fact about
 * the resource — which is how a rate-limited window turned into 530
 * permanently license-less catalog entries.
 *
 * Scoped to the header, not the status: a plain 403 (private repo,
 * blocked content) is a real answer and must stay non-retryable.
 */
function isRateLimited403(res: Response): boolean {
  if (res.status !== 403) return false;
  return res.headers.get('x-ratelimit-remaining') === '0';
}

function jittered(ms: number): number {
  const jitter = ms * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, ms + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
