import {
  DS4_FULL_RESIDENCY_HEADROOM_BYTES,
  LLAMA_CPP_VISION_COMPUTE_BYTES,
  LLAMA_CPP_WEIGHTS_MULTIPLIER,
  ds4FitsFullResidency,
} from '@bendyline/gezel';
import { totalMemoryBytes } from '../../system/host-memory.js';

const GB = 1024 ** 3;

export { DS4_FULL_RESIDENCY_HEADROOM_BYTES };

/**
 * Conservative floor for the full-residency working set. Exclusivity is an
 * explicit device lease at process startup, not a consequence of this number:
 * the automatic model budget can exceed 96 GiB on larger machines.
 *
 * Only for a launch nobody measured: an entry with `fullResidencyMemory` is
 * reserved at that working set ({@link planDs4MeasuredLaunch}). Flooring a
 * 45 GiB Qwen3.8 launch here put it over a 96 GiB Mac's 80 GiB budget.
 */
export const DS4_FULL_RESIDENCY_RESERVATION_BYTES = 96 * GB;

/**
 * Extra resident memory for ds4's `--vision` encoder. The encoder is a GGUF
 * tensor payload plus a separate image graph, matching the two terms measured
 * for llama.cpp vision. Keep this conservative until ds4-specific telemetry
 * gives us a tighter number.
 */
export function ds4VisionResidentBytes(encoderSizeBytes: number | undefined): number {
  if (!encoderSizeBytes || encoderSizeBytes <= 0) return 0;
  return (
    Math.round(encoderSizeBytes * LLAMA_CPP_WEIGHTS_MULTIPLIER) + LLAMA_CPP_VISION_COMPUTE_BYTES
  );
}

/**
 * Base resident working set before optional vision/drafting companions.
 *
 * A catalog `residentBytes` value is a model-specific measurement that already
 * includes runtime overhead. The generic weights multiplier is only a fallback
 * for an unmeasured explicit GGUF; applying it as a lower bound discarded the
 * better measurement and made the measured GLM 5.3 Q2 launch exceed the
 * unified-GPU admission ceiling. Never accept a measurement below the raw
 * weights themselves, which still fails safely for a malformed catalog row.
 */
export function ds4BaseResidentBytes(opts: {
  projectedBytes?: number;
  modelSizeBytes?: number;
}): number {
  const modelSizeBytes = Math.max(0, opts.modelSizeBytes ?? 0);
  if (opts.projectedBytes !== undefined)
    return Math.max(modelSizeBytes, Math.max(0, opts.projectedBytes));
  return Math.round(modelSizeBytes * LLAMA_CPP_WEIGHTS_MULTIPLIER);
}

export interface Ds4ResidencyOptions {
  configured?: boolean;
  /** False when this architecture has no routed-expert SSD-streaming graph. */
  ssdStreamingSupported?: boolean;
  /** Bytes of the selected GGUF that actually become resident model weights. */
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
    totalRamBytes: opts.totalRamBytes ?? totalMemoryBytes(),
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
  if (opts.ssdStreamingSupported === false) return false;
  if (opts.configured === true) return true;
  return !canUseDs4FullResidency(opts);
}

export interface Ds4ExpertCachePlanOptions {
  configuredGb?: number;
  catalogCacheBytes?: number;
  catalogResidentBytes?: number;
  totalRamBytes?: number;
  /**
   * A measured streamed footprint at the launch window, sidecars included
   * ({@link ds4StreamingFixedBytes}). With {@link budgetBytes} it replaces the
   * catalog subtraction and the generic 24 GiB headroom.
   */
  measuredFixedBytes?: number;
  /** This device's local-model budget, the ceiling the capacity broker admits under. */
  budgetBytes?: number;
  /** Smallest cache the entry says is worth streaming with. */
  minCacheBytes?: number;
}

export interface Ds4ExpertCachePlan {
  cacheGb: number;
  requestedGb: number;
  clamped: boolean;
  safe: boolean;
  /**
   * What bounded the cache: the device's local-model budget beside a measured
   * footprint, or the generic {@link DS4_FULL_RESIDENCY_HEADROOM_BYTES}.
   */
  limit: 'model-budget' | 'headroom';
}

/**
 * Pick a bounded routed-expert cache for streaming mode. Catalog guidance is
 * model-aware (Q2 currently recommends 32 GiB; Q4 recommends 64 GiB), unlike
 * the old RAM-tier heuristic which incorrectly gave both models 64 GiB on a
 * 128 GiB Mac. Manual values are still accepted, but clamped so fixed model
 * state + the cache cannot consume the runtime/OS reserve.
 *
 * The 24 GiB headroom guards a footprint guessed as `residentBytes −
 * cacheExpertsBytes`, which omits graph and staging memory ds4 also holds.
 * An entry with a measured streamed footprint has no such gap, so its cache
 * may use whatever this device's local-model budget leaves beside it. A fixed
 * 24 GiB refused Qwen3.8 on 32 GiB Macs whose budget held it with room to spare.
 */
export function planDs4ExpertCache(opts: Ds4ExpertCachePlanOptions): Ds4ExpertCachePlan {
  const totalRamBytes = opts.totalRamBytes ?? totalMemoryBytes();
  const catalogCacheBytes = opts.catalogCacheBytes ?? 0;
  const fallbackGb = totalRamBytes >= 120 * GB ? 64 : totalRamBytes >= 88 * GB ? 48 : 32;
  const requestedGb =
    opts.configuredGb ?? (catalogCacheBytes > 0 ? catalogCacheBytes / GB : fallbackGb);
  const modelBudget = opts.measuredFixedBytes !== undefined && opts.budgetBytes !== undefined;
  const safeCacheBytes = modelBudget
    ? opts.budgetBytes! - opts.measuredFixedBytes!
    : totalRamBytes -
      Math.max(0, (opts.catalogResidentBytes ?? 0) - catalogCacheBytes) -
      DS4_FULL_RESIDENCY_HEADROOM_BYTES;
  const safeCacheGb = Math.floor(safeCacheBytes / GB);
  const minCacheGb = Math.max(1, Math.ceil((opts.minCacheBytes ?? 0) / GB));
  const limit = modelBudget ? 'model-budget' : 'headroom';

  if (safeCacheGb < minCacheGb) {
    return { cacheGb: minCacheGb, requestedGb, clamped: true, safe: false, limit };
  }

  const cacheGb = Math.max(minCacheGb, Math.min(requestedGb, safeCacheGb));
  return { cacheGb, requestedGb, clamped: cacheGb !== requestedGb, safe: true, limit };
}

/** A measured ds4 memory line from the catalog: bytes at a window, plus a per-token slope. */
export interface Ds4MeasuredLine {
  bytes: number;
  ctxTokens: number;
  bytesPerToken: number;
}

/** Evaluate a measured line at a window, never below its context-free part. */
export function ds4MeasuredBytesAt(line: Ds4MeasuredLine, ctxTokens: number): number {
  const contextFree = Math.max(0, line.bytes - line.bytesPerToken * line.ctxTokens);
  return Math.round(contextFree + line.bytesPerToken * Math.max(0, ctxTokens));
}

/** The memory fields of a catalog `ds4` block that price a launch. */
export interface Ds4MemorySource {
  cacheExpertsBytes?: number | undefined;
  fullResidencyMemory?:
    | { workingSetBytes: number; ctxTokens: number; bytesPerToken: number }
    | undefined;
  streamingMemory?:
    | { fixedBytes: number; ctxTokens: number; bytesPerToken: number; minCacheBytes?: number }
    | undefined;
}

function fullResidencyLine(source: Ds4MemorySource | undefined): Ds4MeasuredLine | undefined {
  const m = source?.fullResidencyMemory;
  return m
    ? { bytes: m.workingSetBytes, ctxTokens: m.ctxTokens, bytesPerToken: m.bytesPerToken }
    : undefined;
}

function streamingLine(source: Ds4MemorySource | undefined): Ds4MeasuredLine | undefined {
  const m = source?.streamingMemory;
  return m
    ? { bytes: m.fixedBytes, ctxTokens: m.ctxTokens, bytesPerToken: m.bytesPerToken }
    : undefined;
}

/** Measured streamed footprint without the expert cache, at a window; undefined when unmeasured. */
export function ds4StreamingFixedBytes(
  source: Ds4MemorySource | undefined,
  ctxTokens: number,
): number | undefined {
  const line = streamingLine(source);
  return line ? ds4MeasuredBytesAt(line, ctxTokens) : undefined;
}

export interface Ds4MeasuredLaunchOptions {
  source: Ds4MemorySource | undefined;
  numCtx: number;
  ssdStreaming: boolean;
  totalRamBytes: number;
  /** Local-model budget, needed to size a streamed launch's cache. */
  budgetBytes?: number | undefined;
  /** Resident memory beside the model: a vision encoder, a DSpark companion. */
  sidecarBytes?: number;
  configuredCacheGb?: number | undefined;
}

export interface Ds4MeasuredLaunch {
  /** What the launch holds, sidecars included. The broker reserves exactly this. */
  workingSetBytes: number;
  /** The part of {@link workingSetBytes} the window does not move. */
  contextFreeBytes: number;
  bytesPerToken: number;
  /** Streamed launches only. */
  cache?: Ds4ExpertCachePlan;
}

/**
 * Price a launch from the entry's measurement for the chosen mode. Undefined
 * when that mode is unmeasured (or a streamed launch has no budget to size
 * against), so callers keep their catalog-`residentBytes` path, including the
 * 96 GiB full-residency floor that stands in for a missing measurement.
 */
export function planDs4MeasuredLaunch(
  opts: Ds4MeasuredLaunchOptions,
): Ds4MeasuredLaunch | undefined {
  const sidecarBytes = opts.sidecarBytes ?? 0;
  if (!opts.ssdStreaming) {
    const line = fullResidencyLine(opts.source);
    if (!line) return undefined;
    const contextFreeBytes = ds4MeasuredBytesAt(line, 0) + sidecarBytes;
    return {
      workingSetBytes: contextFreeBytes + line.bytesPerToken * Math.max(0, opts.numCtx),
      contextFreeBytes,
      bytesPerToken: line.bytesPerToken,
    };
  }
  const line = streamingLine(opts.source);
  if (!line || opts.budgetBytes === undefined) return undefined;
  const fixedBytes = ds4MeasuredBytesAt(line, opts.numCtx) + sidecarBytes;
  const cache = planDs4ExpertCache({
    ...(opts.configuredCacheGb !== undefined ? { configuredGb: opts.configuredCacheGb } : {}),
    ...(opts.source?.cacheExpertsBytes !== undefined
      ? { catalogCacheBytes: opts.source.cacheExpertsBytes }
      : {}),
    totalRamBytes: opts.totalRamBytes,
    measuredFixedBytes: fixedBytes,
    budgetBytes: opts.budgetBytes,
    ...(opts.source?.streamingMemory?.minCacheBytes !== undefined
      ? { minCacheBytes: opts.source.streamingMemory.minCacheBytes }
      : {}),
  });
  const cacheBytes = cache.cacheGb * GB;
  return {
    workingSetBytes: fixedBytes + cacheBytes,
    contextFreeBytes: ds4MeasuredBytesAt(line, 0) + sidecarBytes + cacheBytes,
    bytesPerToken: line.bytesPerToken,
    cache,
  };
}

/** Effective capacity-broker reservation for the chosen DS4 residency mode. */
export function ds4ResidentBytesForMode(
  catalogResidentBytes: number,
  ssdStreaming: boolean,
  ssdStreamingSupported = true,
): number {
  return ssdStreaming || !ssdStreamingSupported
    ? catalogResidentBytes
    : Math.max(catalogResidentBytes, DS4_FULL_RESIDENCY_RESERVATION_BYTES);
}

/** Allowance for ds4's compute and staging buffers beyond weights and KV rows. */
export const DS4_RUNTIME_BUFFER_BYTES = 4 * GB;

/**
 * Accelerator bytes a launch actually wires, for device admission's GPU
 * check. `ds4ResidentBytesForMode` floors the RAM reservation at 96 GiB, and
 * handing that floor over as GPU bytes compared it against a unified host's
 * 0.75 × RAM ceiling — 91.2 GiB on a 121.6 GiB DGX Spark — so every
 * full-residency deepseek-v4-flash q2 launch was refused, although ds4 itself
 * plans that model at ~84 GiB (2026-09-29). Undefined when the floor did not
 * raise the reservation: the reservation is then the working set already.
 */
export function ds4AdmissionGpuBytes(opts: {
  workingSetBytes: number;
  reservationBytes: number;
  kvBytesPerToken?: number | undefined;
  numCtx: number;
}): number | undefined {
  if (opts.reservationBytes <= opts.workingSetBytes) return undefined;
  const wired =
    opts.workingSetBytes + (opts.kvBytesPerToken ?? 0) * opts.numCtx + DS4_RUNTIME_BUFFER_BYTES;
  return Math.min(opts.reservationBytes, wired);
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
