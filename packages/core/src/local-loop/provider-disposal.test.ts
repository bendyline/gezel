import { describe, expect, it, vi } from 'vitest';
import { ProviderQueue } from '../runtime/provider-queue.js';
import {
  ProviderDisposedError,
  ProviderDrainingError,
  runOnLiveProvider,
} from './provider-disposal.js';

function liveProvider(queue = new ProviderQueue({ concurrency: 1 })) {
  return { name: 'llama-cpp', isDisposed: false, queue };
}

describe('runOnLiveProvider', () => {
  it('steps aside before starting when a swap is waiting for the engine', async () => {
    const send = vi.fn(async () => 'ran');
    await expect(
      runOnLiveProvider(
        liveProvider(),
        { queue: { lane: 'interactive', yieldToSwap: () => true } },
        send,
      ),
    ).rejects.toBeInstanceOf(ProviderDrainingError);
    expect(send).not.toHaveBeenCalled();
  });

  it('re-checks once admitted, so a turn queued behind the running one does not start', async () => {
    const queue = new ProviderQueue({ concurrency: 1 });
    const releaseRunning = await queue.acquire({ lane: 'background' });
    let swapWaiting = false;
    const send = vi.fn(async () => 'ran');

    const queued = runOnLiveProvider(
      liveProvider(queue),
      { queue: { lane: 'interactive', yieldToSwap: () => swapWaiting } },
      send,
    );
    swapWaiting = true;
    releaseRunning();

    await expect(queued).rejects.toBeInstanceOf(ProviderDrainingError);
    expect(send).not.toHaveBeenCalled();
    expect(queue.snapshot()).toEqual({ running: 0, queuedInteractive: 0, queuedBackground: 0 });
  });

  it('runs the turn when no swap is waiting', async () => {
    await expect(
      runOnLiveProvider(
        liveProvider(),
        { queue: { lane: 'interactive', yieldToSwap: () => false } },
        async () => 'ran',
      ),
    ).resolves.toBe('ran');
  });

  it('carries the disposed-provider retry contract', () => {
    expect(new ProviderDrainingError('mlx')).toBeInstanceOf(ProviderDisposedError);
  });
});
