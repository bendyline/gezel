import { describe, expect, it, vi } from 'vitest';
import { observeShutdownStep } from './shutdown-progress.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe('observeShutdownStep', () => {
  it('stays quiet when a shutdown step finishes within its budget', async () => {
    const warn = vi.fn();

    await expect(
      observeShutdownStep('quick cleanup', async () => 'done', { slowStepMs: 25, warn }),
    ).resolves.toBe('done');
    expect(warn).not.toHaveBeenCalled();
  });

  it('names a slow step and reports when it eventually finishes', async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<void>();
      const warn = vi.fn();
      const running = observeShutdownStep('chat background drain', () => pending.promise, {
        slowStepMs: 25,
        warn,
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(warn).toHaveBeenCalledWith(
        '[service] shutdown step "chat background drain" is still running after 25ms',
      );

      pending.resolve();
      await running;
      expect(warn).toHaveBeenLastCalledWith(
        '[service] shutdown step "chat background drain" finished after 25ms',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears its slow-step timer when the action rejects promptly', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const error = new Error('cleanup failed');

      await expect(
        observeShutdownStep(
          'failing cleanup',
          async () => {
            throw error;
          },
          { slowStepMs: 25, warn },
        ),
      ).rejects.toBe(error);
      await vi.advanceTimersByTimeAsync(25);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
