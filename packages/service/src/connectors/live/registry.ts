import type { LiveAdapter } from './types.js';

/**
 * Device adapters by `source.adapterId`. Unlike native sync adapters (built
 * per pass), a live adapter is one long-lived object per adapter id that the
 * host runs once per binding; per-binding state lives inside `run`.
 */
const LIVE_ADAPTERS = new Map<string, LiveAdapter>();

export function registerLiveAdapter(adapterId: string, adapter: LiveAdapter): void {
  LIVE_ADAPTERS.set(adapterId, adapter);
}

export function liveAdapterFor(adapterId: string): LiveAdapter | undefined {
  return LIVE_ADAPTERS.get(adapterId);
}

export function clearLiveAdaptersForTests(): void {
  LIVE_ADAPTERS.clear();
}
