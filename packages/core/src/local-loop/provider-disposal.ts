import {
  type ProviderQueue,
  type QueueLease,
  UNQUEUED_LEASE,
  runInQueue,
} from '../runtime/provider-queue.js';
import type { SendAndWaitOpts } from './provider-contract.js';

/** Safe to retry only when rejected before a session starts inference or tools. */
export class ProviderDisposedError extends Error {
  constructor(provider: string, message?: string) {
    super(message ?? `[${provider}] provider disposed (engine was evicted) — re-resolve it`);
    this.name = 'ProviderDisposedError';
  }
}

/**
 * The turn stepped aside before it started: its engine is being unloaded so
 * another model can load. Same retry contract as a disposed provider — the
 * caller rebinds, which waits for the swap and loads this model back.
 */
export class ProviderDrainingError extends ProviderDisposedError {
  constructor(provider: string) {
    super(provider, `[${provider}] engine is being swapped for another model — re-resolve it`);
    this.name = 'ProviderDrainingError';
  }
}

/** Queue admission may outlive an engine generation; neither check may run tools. */
export async function runOnLiveProvider(
  provider: { readonly name: string; readonly isDisposed: boolean; readonly queue: ProviderQueue },
  opts: SendAndWaitOpts | undefined,
  send: (lease: QueueLease) => Promise<string>,
): Promise<string> {
  const assertLive = () => {
    if (provider.isDisposed) throw new ProviderDisposedError(provider.name);
    // Checked again after admission: a turn that queued behind the one
    // still running must not start a fresh turn on an engine a waiting
    // swap is about to unload.
    if (opts?.queue?.yieldToSwap?.()) throw new ProviderDrainingError(provider.name);
  };
  assertLive();
  const start = (lease: QueueLease) => {
    assertLive();
    return send(lease);
  };
  if (opts?.queue?.bypassQueue) return start(UNQUEUED_LEASE);
  return runInQueue(provider.queue, opts?.queue, start);
}
