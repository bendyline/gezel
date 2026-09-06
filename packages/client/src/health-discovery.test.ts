import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HEALTH_TIMEOUT_MS, requestDaemonHealth } from './health-discovery.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function untilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );
}

describe('health discovery deadline', () => {
  it('aborts a fetch that never produces headers until aborted', async () => {
    let signal!: AbortSignal;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      return untilAbort(signal);
    });
    const result = requestDaemonHealth('http://localhost', {
      fetch: fetchImpl as typeof fetch,
      timeoutMs: 100,
    });
    const failed = expect(result).rejects.toThrow('Health check timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the same five-second budget for delayed headers and a stalled body', async () => {
    let signal!: AbortSignal;
    let bodyAborted = false;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init!.signal!;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"version":'));
            signal.addEventListener(
              'abort',
              () => {
                bodyAborted = true;
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
        }),
      );
    });
    const result = requestDaemonHealth('http://localhost', { fetch: fetchImpl as typeof fetch });
    const failed = expect(result).rejects.toThrow(
      `Health check timed out after ${DEFAULT_HEALTH_TIMEOUT_MS}ms`,
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(bodyAborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also returns on time when a custom fetch ignores abort entirely', async () => {
    const result = requestDaemonHealth('http://localhost', {
      fetch: () => new Promise<Response>(() => {}),
      timeoutMs: 100,
    });
    const failed = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([new Response('{"version":"1.2.3"}'), new Response('legacy health')])(
    'disposes the timer after a completed response',
    async (response) => {
      let signal!: AbortSignal;
      const result = await requestDaemonHealth('http://localhost/', {
        fetch: async (_url, init) => {
          signal = init!.signal!;
          return response;
        },
      });
      expect(result.ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(signal.aborted).toBe(false);
    },
  );

  it('cancels an unsuccessful HTTP response without waiting for its body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const result = await requestDaemonHealth('http://localhost', {
      fetch: async () => new Response(body, { status: 503 }),
    });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid timeout %s without starting a request',
    async (timeoutMs) => {
      const fetchImpl = vi.fn();
      await expect(
        requestDaemonHealth('http://localhost', { fetch: fetchImpl, timeoutMs }),
      ).rejects.toThrow(RangeError);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
