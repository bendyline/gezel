import { totalmem } from 'node:os';

const GB = 1024 ** 3;

/**
 * Memory kept outside the GGUF when considering full residency. This covers
 * the OS + foreground apps as well as Metal/CUDA context and compute buffers.
 * The measured IQ2_XXS working set is ~103 GiB for an ~81 GiB GGUF, so 32 GiB
 * leaves roughly 10 GiB beyond that measured engine overhead on a 128 GiB Mac.
 */
export const DS4_FULL_RESIDENCY_HEADROOM_BYTES = 32 * GB;

/**
 * Full residency must monopolize the local-engine broker. The broker's normal
 * workstation ceiling is 96 GiB; reserving that ceiling prevents a second
 * local model from being admitted while DS4's measured ~103 GiB working set is
 * live, without requiring a global capacity-policy increase.
 */
export const DS4_FULL_RESIDENCY_RESERVATION_BYTES = 96 * GB;

export interface Ds4ResidencyOptions {
  configured?: boolean;
  /** Size of the selected GGUF. Unknown sizes are never allowed full residency. */
  modelSizeBytes?: number;
  totalRamBytes?: number;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * Whether this exact model can be made fully resident without consuming the
 * memory macOS/Linux and ds4's runtime still need. Full residency is only a
 * meaningful local choice on unified-memory arm64 machines; discrete-GPU
 * capacity cannot be inferred from system RAM here.
 */
export function canUseDs4FullResidency(opts: Ds4ResidencyOptions = {}): boolean {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const totalRamBytes = opts.totalRamBytes ?? totalmem();
  const modelSizeBytes = opts.modelSizeBytes;
  const unifiedMemoryTarget = arch === 'arm64' && (platform === 'darwin' || platform === 'linux');

  return Boolean(
    unifiedMemoryTarget &&
      modelSizeBytes &&
      modelSizeBytes + DS4_FULL_RESIDENCY_HEADROOM_BYTES <= totalRamBytes,
  );
}

/**
 * Decide whether ds4 should stream experts from SSD.
 *
 * Streaming is the safe default. An explicit request to disable it is honored
 * only when the selected GGUF plus runtime/OS headroom fits this unified-memory
 * machine. This keeps stale config and hand-edited config.json files from
 * turning a model picker action into a system-wide memory-pressure event.
 */
export function shouldUseDs4SsdStreaming(opts: Ds4ResidencyOptions = {}): boolean {
  if (opts.configured !== false) return true;
  return !canUseDs4FullResidency(opts);
}

export interface Ds4ExpertCachePlanOptions {
  configuredGb?: number;
  catalogCacheBytes?: number;
  catalogResidentBytes?: number;
  totalRamBytes?: number;
}

export interface Ds4ExpertCachePlan {
  cacheGb: number;
  requestedGb: number;
  clamped: boolean;
  safe: boolean;
}

/**
 * Pick a bounded routed-expert cache for streaming mode. Catalog guidance is
 * model-aware (Q2 currently recommends 32 GiB; Q4 recommends 64 GiB), unlike
 * the old RAM-tier heuristic which incorrectly gave both models 64 GiB on a
 * 128 GiB Mac. Manual values are still accepted, but clamped so fixed model
 * state + the cache cannot consume the runtime/OS reserve.
 */
export function planDs4ExpertCache(opts: Ds4ExpertCachePlanOptions): Ds4ExpertCachePlan {
  const totalRamBytes = opts.totalRamBytes ?? totalmem();
  const catalogCacheBytes = opts.catalogCacheBytes ?? 0;
  const fixedResidentBytes = Math.max(0, (opts.catalogResidentBytes ?? 0) - catalogCacheBytes);
  const fallbackGb = totalRamBytes >= 120 * GB ? 64 : totalRamBytes >= 88 * GB ? 48 : 32;
  const requestedGb =
    opts.configuredGb ?? (catalogCacheBytes > 0 ? catalogCacheBytes / GB : fallbackGb);
  const safeCacheBytes = totalRamBytes - fixedResidentBytes - DS4_FULL_RESIDENCY_HEADROOM_BYTES;
  const safeCacheGb = Math.floor(safeCacheBytes / GB);

  if (safeCacheGb < 1) {
    return { cacheGb: 1, requestedGb, clamped: true, safe: false };
  }

  const cacheGb = Math.max(1, Math.min(requestedGb, safeCacheGb));
  return { cacheGb, requestedGb, clamped: cacheGb !== requestedGb, safe: true };
}

/** Effective capacity-broker reservation for the chosen DS4 residency mode. */
export function ds4ResidentBytesForMode(
  catalogResidentBytes: number,
  ssdStreaming: boolean,
): number {
  return ssdStreaming
    ? catalogResidentBytes
    : Math.max(catalogResidentBytes, DS4_FULL_RESIDENCY_RESERVATION_BYTES);
}
