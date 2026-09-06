import { type ProviderQueue, runInQueue } from './queue.js';
import type { SendAndWaitOpts } from './types.js';

/** Safe to retry only when rejected before a session starts inference or tools. */
export class ProviderDisposedError extends Error {
  constructor(provider: string) {
    super(`[${provider}] provider disposed (engine was evicted) — re-resolve it`);
    this.name = 'ProviderDisposedError';
  }
}

/** Queue admission may outlive an engine generation; neither check may run tools. */
export async function runOnLiveProvider(
  provider: { readonly name: string; readonly isDisposed: boolean; readonly queue: ProviderQueue },
  opts: SendAndWaitOpts | undefined,
  send: () => Promise<string>,
): Promise<string> {
  if (provider.isDisposed) throw new ProviderDisposedError(provider.name);
  const start = () => {
    if (provider.isDisposed) throw new ProviderDisposedError(provider.name);
    return send();
  };
  if (opts?.queue?.bypassQueue) return start();
  return runInQueue(provider.queue, opts?.queue, start);
}
