/** Regression coverage for bounded buffered reads and mutation/stream exclusion. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GezelClient } from './client.js';

const reset = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
const brokenBody = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"path":"partial"'));
        controller.error(reset());
      },
    }),
  );
const makeClient = (fetchImpl: typeof fetch) =>
  new GezelClient({ baseUrl: 'http://test', token: 'token', fetch: fetchImpl });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('buffered GET recovery', () => {
  it.each(['headers', 'body'] as const)(
    'recovers artifact input after a %s reset',
    async (phase) => {
      const good = {
        path: 'video-000006/item-5/judge/input.json',
        content: '{"binding":"expected"}',
      };
      const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json(good));
      if (phase === 'headers') fetchImpl.mockReset().mockRejectedValueOnce(reset());
      else fetchImpl.mockReset().mockResolvedValueOnce(brokenBody());
      fetchImpl.mockResolvedValueOnce(Response.json(good));
      const controller = new AbortController();
      const pending = makeClient(fetchImpl).readProjectArtifact(
        'qualla-internal',
        good.path,
        controller.signal,
      );
      await vi.runAllTimersAsync();
      expect(await pending).toEqual(good);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const [url, init] of fetchImpl.mock.calls) {
        expect(String(url)).toContain(
          '/artifacts/read?path=video-000006%2Fitem-5%2Fjudge%2Finput.json',
        );
        expect(init.method).toBe('GET');
        expect(init.signal).toBe(controller.signal);
        expect(init.body).toBeUndefined();
      }
    },
  );

  it('uses the same read policy for config metadata and artifact blobs', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(reset())
      .mockResolvedValueOnce(Response.json({ config: {} }))
      .mockResolvedValueOnce(brokenBody())
      .mockResolvedValueOnce(new Response('complete bytes'));
    const client = makeClient(fetchImpl);
    const config = client.getConfig();
    await vi.runAllTimersAsync();
    expect(await config).toEqual({ config: {} });
    const blob = client.fetchProjectArtifactBlob('p', 'image.png');
    await vi.runAllTimersAsync();
    expect(await (await blob).text()).toBe('complete bytes');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('marks exhaustion after four total attempts for outer observers', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(reset());
    const pending = makeClient(fetchImpl)
      .health()
      .catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      status: 0,
      details: {
        kind: 'transport',
        readRetryExhausted: true,
        attempts: 4,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('honors cancellation during backoff without resetting the caller deadline', async () => {
    const controller = new AbortController();
    const reason = new Error('Original deadline expired');
    const fetchImpl = vi.fn().mockRejectedValue(reset());
    const pending = makeClient(fetchImpl)
      .health(controller.signal)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(reason);
    await vi.runAllTimersAsync();
    expect(await pending).toBe(reason);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('forwards the original signal to a replay and aborts its in-flight body', async () => {
    const controller = new AbortController();
    const reason = new Error('Canceled');
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(reset())
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            expect(init.signal).toBe(controller.signal);
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          }),
      );
    const pending = makeClient(fetchImpl)
      .health(controller.signal)
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(250);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 429, 500, 503])(
    'never retries HTTP %i, even with a broken error body',
    async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(reset());
            },
          }),
          { status },
        ),
      );
      await expect(makeClient(fetchImpl).health()).rejects.toMatchObject({ status });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it.each([
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('self-signed certificate'), {
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      }),
    }),
    new SyntaxError('Invalid JSON ECONNRESET'),
    new Error('Programming error'),
  ])('does not retry non-network errors: %s', async (error) => {
    const fetchImpl = vi.fn().mockRejectedValue(error);
    await expect(makeClient(fetchImpl).health()).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not replay malformed successful JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{ invalid ECONNRESET'));
    await expect(makeClient(fetchImpl).health()).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(['headers', 'body'] as const)(
    'does not replay a mutation after a %s failure',
    async (phase) => {
      const fetchImpl =
        phase === 'headers'
          ? vi.fn().mockRejectedValue(reset())
          : vi.fn().mockResolvedValue(brokenBody());
      await expect(makeClient(fetchImpl).updateConfig({})).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('PUT');
    },
  );

  it('leaves streaming API failures to the stream owner', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(reset());
    await expect(makeClient(fetchImpl).installSystemToolset('fixture', () => {})).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
