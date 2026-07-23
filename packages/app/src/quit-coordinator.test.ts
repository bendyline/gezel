import { describe, expect, it, vi } from 'vitest';
import { QuitCoordinator } from './quit-coordinator.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('QuitCoordinator', () => {
  it('prevents and coalesces quit requests until one shutdown completes', async () => {
    const pending = deferred();
    const shutdown = vi.fn(() => pending.promise);
    const quitAgain = vi.fn();
    const coordinator = new QuitCoordinator({ shutdown, quitAgain });
    const first = { preventDefault: vi.fn() };
    const duplicate = { preventDefault: vi.fn() };

    coordinator.handleBeforeQuit(first);
    coordinator.handleBeforeQuit(duplicate);

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(duplicate.preventDefault).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(quitAgain).not.toHaveBeenCalled();

    pending.resolve();
    await pending.promise;
    await vi.waitFor(() => expect(quitAgain).toHaveBeenCalledOnce());

    const finalQuit = { preventDefault: vi.fn() };
    coordinator.handleBeforeQuit(finalQuit);
    expect(finalQuit.preventDefault).not.toHaveBeenCalled();
  });

  it('reports a shutdown error but still allows the second quit', async () => {
    const error = new Error('flush failed');
    const onError = vi.fn();
    const quitAgain = vi.fn();
    const coordinator = new QuitCoordinator({
      shutdown: async () => {
        throw error;
      },
      quitAgain,
      onError,
    });

    coordinator.handleBeforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quitAgain).toHaveBeenCalledOnce());
    expect(onError).toHaveBeenCalledWith(error);
  });
});
