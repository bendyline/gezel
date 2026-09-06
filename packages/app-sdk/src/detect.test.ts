import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectGezel } from './detect.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-detect-deadline-'));
  await mkdir(join(home, 'runtime'));
  await writeFile(join(home, 'runtime', 'port'), '6228');
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

describe('detectGezel', () => {
  it.each(['headers', 'body', 'ignores-abort'] as const)(
    'reports not running when %s stalls',
    async (phase) => {
      let signal!: AbortSignal;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const close = vi.fn(async () => {});
      const destroy = vi.fn(async () => {});
      const fetchImpl = Object.assign(
        vi.fn(async (_url: unknown, init?: RequestInit) => {
          signal = init!.signal!;
          started();
          if (phase === 'body')
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"version":'));
                  signal.addEventListener('abort', () => controller.error(signal.reason), {
                    once: true,
                  });
                },
              }),
            );
          return new Promise<Response>((_resolve, reject) => {
            if (phase !== 'ignores-abort')
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }),
        { close, destroy },
      );
      const pending = detectGezel({ home, fetch: fetchImpl as typeof fetch, timeoutMs: 100 });
      await ready;
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({
        installed: true,
        running: false,
        baseUrl: 'http://127.0.0.1:6228',
      });
      expect(signal.aborted).toBe(true);
      expect(close).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('returns version metadata and leaves no timer behind', async () => {
    const result = await detectGezel({
      home,
      fetch: async () => new Response('{"version":"1.2.3"}'),
    });
    expect(result).toMatchObject({ installed: true, running: true, version: '1.2.3' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps compatibility with a completed non-JSON health response', async () => {
    expect(await detectGezel({ home, fetch: async () => new Response('healthy') })).toMatchObject({
      running: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
