import { describe, expect, it } from 'vitest';
import {
  HttpStatusError,
  backoffDelayMs,
  fetchWithRetry,
  flattenErrorMessage,
  isTransientHttpStatus,
  isTransientNetworkError,
  retryTransient,
  sleepWithAbort,
} from './net-retry.js';

/** Keep the tests off the real backoff schedule. */
const FAST = { schedule: [1, 1, 1, 1, 1] };

describe('isTransientNetworkError', () => {
  it('matches the undici "fetch failed" wrapper and its errno cause', () => {
    const err = new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('matches errno-only errors carried on `code`', () => {
    const err = Object.assign(new Error('connect'), { code: 'ENOTFOUND' });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('does not retry aborts — a cancel means stop', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it('does not retry ordinary programming errors', () => {
    expect(isTransientNetworkError(new TypeError('x.map is not a function'))).toBe(false);
  });

  it('derives retryability from HttpStatusError status codes', () => {
    expect(isTransientNetworkError(new HttpStatusError(503))).toBe(true);
    expect(isTransientNetworkError(new HttpStatusError(429))).toBe(true);
    expect(isTransientNetworkError(new HttpStatusError(404))).toBe(false);
    expect(isTransientNetworkError(new HttpStatusError(403))).toBe(false);
  });
});

describe('isTransientHttpStatus', () => {
  it('treats 5xx / 408 / 429 as worth another pass and other 4xx as terminal', () => {
    expect(isTransientHttpStatus(500)).toBe(true);
    expect(isTransientHttpStatus(502)).toBe(true);
    expect(isTransientHttpStatus(408)).toBe(true);
    expect(isTransientHttpStatus(429)).toBe(true);
    expect(isTransientHttpStatus(400)).toBe(false);
    expect(isTransientHttpStatus(404)).toBe(false);
  });
});

describe('flattenErrorMessage', () => {
  it('walks the cause chain', () => {
    const err = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND hf.co') });
    expect(flattenErrorMessage(err)).toContain('fetch failed');
    expect(flattenErrorMessage(err)).toContain('ENOTFOUND');
  });

  it('survives a self-referencing cause without looping forever', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(flattenErrorMessage(err)).toBe('Error: loop');
  });
});

describe('backoffDelayMs', () => {
  it('climbs the schedule and clamps at the last rung', () => {
    const noJitter = () => 0.5;
    expect(backoffDelayMs(0, [100, 200, 400], noJitter)).toBe(100);
    expect(backoffDelayMs(1, [100, 200, 400], noJitter)).toBe(200);
    expect(backoffDelayMs(9, [100, 200, 400], noJitter)).toBe(400);
  });

  it('applies +/-20% jitter so parallel transfers do not re-collide', () => {
    expect(backoffDelayMs(0, [1000], () => 0)).toBe(800);
    expect(backoffDelayMs(0, [1000], () => 1)).toBe(1200);
  });
});

describe('retryTransient', () => {
  it('returns the first success without waiting', async () => {
    let calls = 0;
    const out = await retryTransient(
      async () => {
        calls++;
        return 'ok';
      },
      { ...FAST },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a transient failure and succeeds on a later attempt', async () => {
    let calls = 0;
    const seen: number[] = [];
    const out = await retryTransient(
      async () => {
        calls++;
        if (calls < 3) throw new TypeError('fetch failed');
        return calls;
      },
      { ...FAST, attempts: 3, onRetry: (info) => seen.push(info.attempt) },
    );
    expect(out).toBe(3);
    expect(seen).toEqual([2, 3]);
  });

  it('gives up after the attempt budget and rethrows the last error', async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw new TypeError('fetch failed');
        },
        { ...FAST, attempts: 3 },
      ),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });

  it('rethrows a non-transient failure immediately', async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw new HttpStatusError(404, 'gone');
        },
        { ...FAST, attempts: 5 },
      ),
    ).rejects.toThrow('gone');
    expect(calls).toBe(1);
  });

  it('stops retrying once the signal aborts', async () => {
    const ac = new AbortController();
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          ac.abort();
          throw new TypeError('fetch failed');
        },
        { ...FAST, attempts: 5, signal: ac.signal },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('sleepWithAbort', () => {
  it('reports the abort rather than waiting out the delay', async () => {
    const ac = new AbortController();
    const waited = sleepWithAbort(10_000, ac.signal);
    ac.abort();
    expect(await waited).toBe(true);
  });

  it('resolves false when the wait completes normally', async () => {
    expect(await sleepWithAbort(1)).toBe(false);
  });
});

describe('fetchWithRetry', () => {
  it('retries a 503 and returns the eventual 200', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return calls < 2
        ? new Response('busy', { status: 503 })
        : new Response('hi', { status: 200 });
    };
    const res = await fetchWithRetry('https://hf.test/x', { fetchImpl }, { ...FAST });
    expect(await res.text()).toBe('hi');
    expect(calls).toBe(2);
  });

  it('does not retry a 404', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return new Response('nope', { status: 404 });
    };
    await expect(
      fetchWithRetry('https://hf.test/x', { fetchImpl }, { ...FAST, attempts: 4 }),
    ).rejects.toThrow(HttpStatusError);
    expect(calls).toBe(1);
  });
});
