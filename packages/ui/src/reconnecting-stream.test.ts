import { describe, expect, it, vi } from 'vitest';
import { reconnectingStream } from './reconnecting-stream.js';

describe('reconnectingStream', () => {
  it('opens again after the stream fails, and says so before the next events', async () => {
    const controller = new AbortController();
    let opens = 0;
    const order: string[] = [];
    async function* open(): AsyncGenerator<string> {
      opens += 1;
      if (opens === 1) {
        yield 'first';
        throw new Error('SSE stream stale');
      }
      yield 'after-reconnect';
      await new Promise<void>(() => {});
    }
    const onError = vi.fn();
    const stream = reconnectingStream(open, {
      signal: controller.signal,
      minDelayMs: 1,
      onReconnect: () => order.push('reconnected'),
      onError,
    });
    order.push((await stream.next()).value as string);
    order.push((await stream.next()).value as string);
    expect(order).toEqual(['first', 'reconnected', 'after-reconnect']);
    expect(onError).toHaveBeenCalledTimes(1);
    controller.abort();
  });

  it('opens again after the stream simply ends', async () => {
    const controller = new AbortController();
    let opens = 0;
    async function* open(): AsyncGenerator<number> {
      opens += 1;
      yield opens;
    }
    const onReconnect = vi.fn();
    const seen: number[] = [];
    for await (const value of reconnectingStream(open, {
      signal: controller.signal,
      minDelayMs: 1,
      onReconnect,
    })) {
      seen.push(value);
      if (seen.length === 3) controller.abort();
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it('stops without reporting an error once the caller aborts', async () => {
    const controller = new AbortController();
    const onError = vi.fn();
    async function* open(signal: AbortSignal): AsyncGenerator<string> {
      await new Promise<void>((_, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
      );
      yield 'never';
    }
    const stream = reconnectingStream(open, { signal: controller.signal, onError });
    const next = stream.next();
    controller.abort();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(onError).not.toHaveBeenCalled();
  });
});
