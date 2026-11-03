import { describe, expect, it } from 'vitest';
import {
  HttpStatusError,
  backoffDelayMs,
  errorMessageWithCause,
  fetchWithRetry,
  flattenErrorMessage,
  innermostErrorReason,
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

  it('matches errno codes as whole uppercase words, not inside class names', () => {
    class YouTubeNotFoundError extends Error {
      constructor() {
        super('YouTube has no channel for @nobody');
        this.name = 'YouTubeNotFoundError';
      }
    }
    expect(isTransientNetworkError(new YouTubeNotFoundError())).toBe(false);
    expect(isTransientNetworkError(new Error('the bridge teagain stopped'))).toBe(false);
    expect(isTransientNetworkError(new Error('getaddrinfo ENOTFOUND api.example.test'))).toBe(true);
    expect(
      isTransientNetworkError(new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } })),
    ).toBe(true);
    expect(isTransientNetworkError(new Error('read EAI_AGAIN'))).toBe(true);
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

describe('errorMessageWithCause', () => {
  it("names the fault undici's bare wrapper hides on `.cause`", () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6228'), {
      code: 'ECONNREFUSED',
    });
    expect(errorMessageWithCause(new TypeError('fetch failed', { cause: refused }))).toBe(
      'fetch failed (connect ECONNREFUSED 127.0.0.1:6228)',
    );
    expect(
      errorMessageWithCause(new TypeError('terminated', { cause: new Error('other side closed') })),
    ).toBe('terminated (other side closed)');
  });

  it('reads a dual-stack AggregateError through its inner errors, then its code', () => {
    const both = Object.assign(
      new AggregateError([new Error('connect ECONNREFUSED ::1:6228')], ''),
      { code: 'ECONNREFUSED' },
    );
    expect(errorMessageWithCause(new TypeError('fetch failed', { cause: both }))).toBe(
      'fetch failed (connect ECONNREFUSED ::1:6228)',
    );
    const codeOnly = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    expect(innermostErrorReason(new TypeError('fetch failed', { cause: codeOnly }))).toBe(
      'ECONNREFUSED',
    );
  });

  it('leaves a message that already says what went wrong alone', () => {
    const wrapped = new Error('[llama-cpp] engine exited before it was ready', {
      cause: new TypeError('fetch failed'),
    });
    expect(errorMessageWithCause(wrapped)).toBe('[llama-cpp] engine exited before it was ready');
    expect(errorMessageWithCause(new TypeError('fetch failed'))).toBe('fetch failed');
    expect(errorMessageWithCause('plain string')).toBe('plain string');
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
