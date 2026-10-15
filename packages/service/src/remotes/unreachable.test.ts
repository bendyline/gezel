import { describe, expect, it, vi } from 'vitest';
import {
  RemoteUnreachableError,
  fetchReachingRemote,
  isRemoteUnreachableError,
} from './unreachable.js';

/** Shaped like undici's `TypeError: fetch failed` with the socket error as its cause. */
function fetchFailed(code: string): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

describe('isRemoteUnreachableError', () => {
  it('recognizes a server that could not be reached, through the cause chain', () => {
    expect(isRemoteUnreachableError(fetchFailed('ECONNREFUSED'))).toBe(true);
    expect(isRemoteUnreachableError(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
    expect(isRemoteUnreachableError(fetchFailed('EHOSTUNREACH'))).toBe(true);
    expect(isRemoteUnreachableError(new RemoteUnreachableError('id', 'Werkbank'))).toBe(true);
  });

  it('does not count a server that answered, or refused the certificate', () => {
    expect(isRemoteUnreachableError(new Error('[remote] /v1/remote/admit returned HTTP 500'))).toBe(
      false,
    );
    expect(isRemoteUnreachableError(fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe(false);
  });
});

describe('fetchReachingRemote', () => {
  const target = { remoteId: 'fp', label: 'Werkbank', onReachability: vi.fn() };

  it('reports any HTTP answer as reached', async () => {
    target.onReachability.mockClear();
    const response = await fetchReachingRemote(
      target,
      (async () => new Response('nope', { status: 500 })) as typeof fetch,
      'https://192.0.2.1:6229/v1/remote/models',
      {},
    );
    expect(response.status).toBe(500);
    expect(target.onReachability).toHaveBeenCalledWith(true);
  });

  it('names an unreachable server in words and reports it', async () => {
    target.onReachability.mockClear();
    const attempt = fetchReachingRemote(
      target,
      (async () => {
        throw fetchFailed('ECONNREFUSED');
      }) as typeof fetch,
      'https://192.0.2.1:6229/v1/remote/infer',
      {},
    );
    await expect(attempt).rejects.toThrow("Werkbank isn't reachable right now");
    await expect(attempt).rejects.toBeInstanceOf(RemoteUnreachableError);
    expect(target.onReachability).toHaveBeenCalledWith(false);
  });

  it("leaves the caller's own abort alone", async () => {
    target.onReachability.mockClear();
    const controller = new AbortController();
    controller.abort();
    const aborted = fetchFailed('ECONNRESET');
    await expect(
      fetchReachingRemote(
        target,
        (async () => {
          throw aborted;
        }) as typeof fetch,
        'https://192.0.2.1:6229/v1/remote/infer',
        { signal: controller.signal },
      ),
    ).rejects.toBe(aborted);
    expect(target.onReachability).not.toHaveBeenCalled();
  });
});
