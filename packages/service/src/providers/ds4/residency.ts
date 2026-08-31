import { totalmem } from 'node:os';
import { DS4_FULL_RESIDENCY_HEADROOM_BYTES, ds4FitsFullResidency } from '@bendyline/gezel';

const GB = 1024 ** 3;

export { DS4_FULL_RESIDENCY_HEADROOM_BYTES };

/**
 * Full residency must monopolize the local-engine broker. The broker's normal
 * workstation ceiling is 96 GiB; reserving that ceiling prevents a second
 * local model from being admitted while DS4's measured working set is live,
 * without requiring a global capacity-policy increase.
 */
export const DS4_FULL_RESIDENCY_RESERVATION_BYTES = 96 * GB;

export interface Ds4ResidencyOptions {
  configured?: boolean;
  /** Size of the selected GGUF. Unknown sizes are never allowed full residency. */
  modelSizeBytes?: number;
  totalRamBytes?: number;
  /**
   * Resident bytes beyond the weights this launch would also hold (a DSpark
   * companion). Not part of `modelSizeBytes`, so residency that ignores it
   * under-reserves by exactly the companion's size.
   */
  companionBytes?: number;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * Whether this exact model can be made fully resident without consuming the
 * memory macOS/Linux and ds4's runtime still need. Delegates to core so the
 * model list's fit badge and this launch decision cannot disagree.
 */
export function canUseDs4FullResidency(opts: Ds4ResidencyOptions = {}): boolean {
  return ds4FitsFullResidency({
    modelSizeBytes: opts.modelSizeBytes,
    totalRamBytes: opts.totalRamBytes ?? totalmem(),
    companionBytes: opts.companionBytes,
    platform: opts.platform ?? process.platform,
    arch: opts.arch ?? process.arch,
  });
}

/**
 * Decide whether ds4 should stream experts from SSD.
 *
 * **Residency is the default wherever it fits.** Streaming is roughly an
 * order of magnitude slower — measured 1.85 tok/s streaming against 18.1
 * tok/s resident for the same IQ2_XXS build on a DGX Spark — so a machine
 * with the memory to hold a model should hold it.
 *
 * This inverts the original policy, which returned `true` unless the config
 * said exactly `false`. Device RAM was then consulted only to VETO a user's
 * explicit opt-out, never to choose residency, so no install ever ran resident
 * without a hand-edited config key that has no UI. The safety direction is
 * unchanged and is what makes the flip safe: a model that does not fit still
 * streams, and {@link canUseDs4FullResidency} is what refuses it.
 *
 * `configured === true` remains an explicit opt-in to streaming and is always
 * honored — a user who wants the memory back can have it.
 */
export function shouldUseDs4SsdStreaming(opts: Ds4ResidencyOptions = {}): boolean {
  if (opts.configured === true) return true;
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

/**
 * DS4's resident footprint as a line in the context window:
 * `contextFreeBytes + kvBytesPerToken × ctx`.
 *
 * The catalog's `residentBytes` is a measurement at ONE window
 * (`residentCtxTokens`), so re-basing it is what lets a 64K and a 256K launch
 * of the same model quote different numbers. Everything that does not move
 * with the window — expert cache, prefill expert reserve, resident non-routed
 * weights, the raw KV rows pinned to the prefill chunk — collapses into
 * `contextFreeBytes`.
 *
 * Same `fixed + slope × ctx` shape llama.cpp/MLX rows already carry, so the
 * models list and the context slider price ds4 through their existing path.
 */
export interface Ds4ResidentLine {
  /** Footprint at a zero-token window: everything the context doesn't move. */
  contextFreeBytes: number;
  /** Resident bytes per context token (compressed KV + scaling buffers). */
  kvBytesPerToken: number;
}

export interface Ds4ResidentLineOptions {
  residentBytes?: number | undefined;
  kvBytesPerToken?: number | undefined;
  residentCtxTokens?: number | undefined;
}

/**
 * Build the line from a catalog `ds4` source block. Returns undefined unless
 * the entry authors all three inputs — a slope without the window it was
 * measured at cannot be re-based, and guessing one would quote confident
 * numbers for a model nobody measured.
 */
export function ds4ResidentLine(opts: Ds4ResidentLineOptions): Ds4ResidentLine | undefined {
  const { residentBytes, kvBytesPerToken, residentCtxTokens } = opts;
  if (!residentBytes || !kvBytesPerToken || !residentCtxTokens) return undefined;
  // A mis-authored slope that swallows the whole footprint would quote a
  // negative floor; clamp rather than propagate it into admission math.
  const contextFreeBytes = Math.max(0, residentBytes - kvBytesPerToken * residentCtxTokens);
  return { contextFreeBytes, kvBytesPerToken };
}

/** Evaluate {@link ds4ResidentLine} at a window. */
export function ds4ProjectedResidentBytes(line: Ds4ResidentLine, ctxTokens: number): number {
  return Math.round(line.contextFreeBytes + line.kvBytesPerToken * Math.max(0, ctxTokens));
}
