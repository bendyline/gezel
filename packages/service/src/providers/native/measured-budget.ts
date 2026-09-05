/**
 * The capacity budget for this host, MEASURED rather than assumed.
 *
 * `computeCapacityBudget()` with no arguments is a synchronous read of an
 * ambient figure that stays `null` until `detectMemoryProfile` has run
 * somewhere in this process (see `detectedGpuVramBytes` in
 * {@link ./capacity-budget.js}). Truly synchronous callers have no
 * alternative, which is why the daemon publishes the probe at boot — but
 * every ASYNC caller that prices an admission should measure instead of
 * hoping the boot probe landed first.
 *
 * A missing card is not a conservative degradation. It removes the
 * accelerator from the admission budget AND from the live-memory cap at the
 * same time, so a 12B model's weights alone can overrun free RAM minus the
 * OS reserve on a machine with room to spare.
 *
 * Wild-caught 2026-09-04: a machine engine's first `/v1/remote/admit` — the
 * cold path every first chat message takes — refused Gemma 4 12B on a
 * 32 GB / 12 GB-VRAM host against "budget 18.7 GB", the RAM share alone,
 * while the same preview granted 157k tokens once anything else had happened
 * to publish the probe.
 */

import { type CapacityBudget, computeCapacityBudget } from './capacity-budget.js';

/**
 * Resolve the auto budget from a live hardware measurement.
 *
 * The profile read is cached for a minute inside `detectMemoryProfileCached`,
 * so calling this per admission costs one `nvidia-smi` per minute at worst.
 * Measuring also publishes the ambient probe as a side effect, which is what
 * repairs the synchronous readers for everything that runs after.
 */
export async function measuredCapacityBudget(): Promise<CapacityBudget> {
  const profile = await (async () => {
    try {
      // Dynamic so this module stays importable from the provider layer that
      // `system/memory.js` itself reaches into for device discovery.
      const { detectMemoryProfileCached } = await import('../../system/memory.js');
      return await detectMemoryProfileCached();
    } catch {
      return null;
    }
  })();
  // A probe that threw keeps the ambient reading rather than asserting "no
  // GPU": an explicit `gpuVramBytes: null` would overwrite a card another
  // caller already measured.
  if (!profile) return computeCapacityBudget();
  return computeCapacityBudget({
    systemRamBytes: profile.totalRamBytes,
    gpuVramBytes: profile.gpuVramBytes,
    unifiedMemory: profile.gpuMemoryKind === 'integrated' || profile.gpuMemoryKind === 'unified',
  });
}
