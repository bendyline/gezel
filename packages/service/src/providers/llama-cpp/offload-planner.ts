/**
 * Hardware-aware MoE offload planner (Phase v3 — graduated).
 *
 * The user's headline case: a big Mixture-of-Experts model on a
 * constrained discrete GPU (e.g. 4–12 GB VRAM + 32–64 GB system RAM).
 * The whole model won't fit in VRAM, but its *attention/dense* layers
 * will — the bulk is the sparse expert weights. b9843's `--cpu-moe`
 * keeps exactly those experts in system RAM (streamed per token) while
 * every attention layer stays on the GPU; `--n-cpu-moe N` is the
 * partial form that keeps only blocks `0..N-1`'s experts in RAM.
 *
 * Two tiers of decision, by input quality:
 *
 *   • **Exact** (`split` present — per-tensor sums from the GGUF header):
 *     size the non-expert residue against VRAM, then pack as many
 *     trailing layers' experts as fit into what's left and emit the
 *     matching `--n-cpu-moe N`. A card that can hold *some* experts no
 *     longer strands that VRAM.
 *
 *   • **Binary** (no split): the v2 behavior, unchanged — all experts to
 *     RAM whenever the resident estimate exceeds VRAM.
 *
 * Pure and deterministic → unit-tested. All I/O (VRAM probe, GGUF read)
 * happens in the caller, which passes plain numbers in.
 *
 * The returned shape is a subset of `PlannerOffloadDecision` from
 * `engine-flags.ts`, so it feeds straight into `buildLlamaCppEngineArgs`
 * as the lowest-precedence layer (global config + manifest still win).
 *
 * When the plan is still too optimistic (KV estimates are coarse, other
 * processes hold VRAM), the launch path degrades it one step per CUDA/
 * Vulkan OOM via {@link degradeMoeOffloadDecision} and retries — see the
 * supervisor's `recoverStartup` hook.
 */

/** 1 GiB of headroom reserved for driver/OS/other-apps beyond the model. */
const DEFAULT_MARGIN_BYTES = 1024 ** 3;

/**
 * Flat reserve for the engine's CUDA/Vulkan compute buffers (activations,
 * graphs) in the exact plan. Sized from observed llama-server allocations
 * on 7B–30B models; the OOM ladder catches the outliers.
 */
const COMPUTE_RESERVE_BYTES = 512 * 1024 ** 2;

export interface MoeExpertSplit {
  /** Bytes `--cpu-moe` leaves on the GPU (attention, dense FFN, shared experts, embeddings). */
  nonExpertBytes: number;
  /** Routed-expert bytes per block, indexed by `blk.N` (0 for dense blocks). */
  expertBytesByLayer: number[];
}

export interface MoeOffloadInput {
  /** True when the GGUF declares `<arch>.expert_count > 1`. */
  isMoE: boolean;
  /**
   * Estimated GPU-resident working set of the model if fully offloaded
   * (weights + KV cache + activations). Callers derive it from
   * `approxSizeBytes * ~1.2`.
   */
  residentBytes: number;
  /** Largest single-GPU VRAM pool in bytes (0 = no GPU device found). */
  vramBytes: number;
  /** Headroom to leave free; defaults to 1 GiB. */
  marginBytes?: number;
  /** Exact per-tensor expert/non-expert sums from the GGUF header, when scanned. */
  split?: MoeExpertSplit;
  /** `<arch>.block_count` — bounds `--n-cpu-moe N`. Defaults to the split's layer count. */
  blockCount?: number;
  /**
   * VRAM the KV cache will hold at the launch context size (all KV stays
   * on-GPU under `-ngl all`). See {@link estimateKvReserveBytes}. Only
   * consulted on the exact path; 0 / absent = weights-only budgeting.
   */
  kvReserveBytes?: number;
}

export interface MoeOffloadDecision {
  /** `--n-gpu-layers` (−1 = all). Undefined = leave to the engine. */
  nGpuLayers?: number;
  /** `--cpu-moe` — keep all MoE experts in system RAM. */
  cpuMoe?: boolean;
  /** `--n-cpu-moe N` — keep blocks `0..N-1`'s experts in system RAM. */
  nCpuMoe?: number;
  /** Human-readable rationale for the decision log (never emitted as a flag). */
  reason?: string;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * Decide how to split a MoE model between VRAM and system RAM.
 *
 * - No GPU / unknown VRAM  → no decision (engine default).
 * - Dense model           → no decision (its `--fit`/`-ngl auto`
 *                            layer-dropping is the right tool).
 * - MoE that fits in VRAM  → no decision (full-GPU residency is fastest).
 * - MoE that won't fit     → with exact tensor sums: keep the largest
 *                            suffix of expert layers that fits beside the
 *                            non-expert residue (`--n-cpu-moe N`), or all
 *                            experts to RAM when none fit; without exact
 *                            sums: `-ngl all --cpu-moe`.
 * - Residue exceeds VRAM   → `--cpu-moe` with NO `-ngl` pin, so the
 *                            engine's own fit can drop whole layers too.
 */
export function planMoeOffload(input: MoeOffloadInput): MoeOffloadDecision {
  const margin = input.marginBytes ?? DEFAULT_MARGIN_BYTES;

  if (!input.vramBytes || input.vramBytes <= 0) {
    return { reason: 'no GPU device detected — leaving GPU offload to the engine' };
  }
  if (!input.isMoE) {
    // Dense model: the engine's `--fit`/`-ngl auto` already right-sizes
    // by dropping whole layers; a MoE-specific split doesn't apply.
    return {};
  }
  if (input.split) return planFromSplit(input, input.split, margin);
  if (input.residentBytes + margin <= input.vramBytes) {
    return {
      reason: `MoE fits VRAM (~${gib(input.residentBytes)} + ${gib(margin)} ≤ ${gib(input.vramBytes)}) — full GPU residency`,
    };
  }
  return {
    nGpuLayers: -1,
    cpuMoe: true,
    reason: `MoE won't fit VRAM (~${gib(input.residentBytes)} + ${gib(margin)} > ${gib(input.vramBytes)}) — --cpu-moe: experts to system RAM, attention on GPU`,
  };
}

function planFromSplit(
  input: MoeOffloadInput,
  split: MoeExpertSplit,
  margin: number,
): MoeOffloadDecision {
  const kvReserve = Math.max(0, input.kvReserveBytes ?? 0);
  const expertTotal = split.expertBytesByLayer.reduce((sum, v) => sum + v, 0);
  const weightsTotal = split.nonExpertBytes + expertTotal;
  const reserves = margin + kvReserve + COMPUTE_RESERVE_BYTES;

  if (weightsTotal + reserves <= input.vramBytes) {
    return {
      reason: `MoE fits VRAM (weights ${gib(weightsTotal)} + reserves ${gib(reserves)} ≤ ${gib(input.vramBytes)}) — full GPU residency`,
    };
  }

  const expertBudget = input.vramBytes - reserves - split.nonExpertBytes;
  if (expertBudget < 0) {
    // Even the always-active residue busts VRAM. Keep experts in RAM but
    // leave `-ngl` unpinned: the engine's own fit drops whole layers to
    // CPU, which a hard `-ngl all` would forbid (that pin is how the v2
    // binary plan OOM'd on sub-6GB cards).
    return {
      cpuMoe: true,
      reason: `non-expert residue ${gib(split.nonExpertBytes)} + reserves ${gib(reserves)} exceed VRAM ${gib(input.vramBytes)} — --cpu-moe with layer count left to the engine`,
    };
  }

  // `--n-cpu-moe N` pins blocks 0..N-1's experts to CPU, so the GPU keeps
  // the trailing layers — pack that suffix greedily.
  const layers = split.expertBytesByLayer;
  const blockCount = input.blockCount ?? layers.length;
  let gpuLayers = 0;
  let gpuExpertBytes = 0;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layerBytes = layers[i] ?? 0;
    if (gpuExpertBytes + layerBytes > expertBudget) break;
    gpuExpertBytes += layerBytes;
    gpuLayers += 1;
  }

  if (gpuLayers <= 0) {
    return {
      nGpuLayers: -1,
      cpuMoe: true,
      reason: `expert budget ${gib(expertBudget)} fits no expert layer (~${gib(layers[layers.length - 1] ?? 0)} each) — --cpu-moe: all experts to system RAM`,
    };
  }
  const nCpuMoe = Math.max(0, blockCount - gpuLayers);
  if (nCpuMoe === 0) {
    return {
      reason: `all ${blockCount} expert layers fit the ${gib(expertBudget)} expert budget — full GPU residency`,
    };
  }
  return {
    nGpuLayers: -1,
    nCpuMoe,
    reason:
      `experts of ${gpuLayers}/${blockCount} layers fit VRAM (${gib(gpuExpertBytes)} of ${gib(expertTotal)}, ` +
      `residue ${gib(split.nonExpertBytes)}, reserves ${gib(reserves)}) — --n-cpu-moe ${nCpuMoe}`,
  };
}

/**
 * One step down the launch-recovery ladder after a GPU out-of-memory at
 * startup. Each step trades speed for admission; `null` means the planner
 * has nothing safer left (dropping `--cpu-moe` itself would put experts
 * BACK on the GPU, which cannot help an OOM).
 *
 *   `--n-cpu-moe N, -ngl all` → `--cpu-moe, -ngl all` → `--cpu-moe` (engine
 *   fit may drop whole layers) → null.
 *
 * Explicit config/manifest offload settings shadow the planner per-field
 * (see `buildLlamaCppEngineArgs`), so degrading a fully-shadowed decision
 * is pointless — the caller checks that before retrying.
 */
export function degradeMoeOffloadDecision(
  decision: MoeOffloadDecision | undefined,
): MoeOffloadDecision | null {
  if (!decision) return null;
  if (typeof decision.nCpuMoe === 'number') {
    return {
      nGpuLayers: -1,
      cpuMoe: true,
      reason: 'GPU OOM at launch — retrying with all experts in system RAM (--cpu-moe)',
    };
  }
  if (decision.cpuMoe && decision.nGpuLayers !== undefined) {
    return {
      cpuMoe: true,
      reason:
        'GPU OOM at launch — retrying with --cpu-moe and the GPU layer count left to the engine',
    };
  }
  return null;
}

/** Bytes per KV element for llama-server's `--cache-type-k/v` values. */
const KV_BYTES_PER_ELEMENT: Record<string, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_1: 24 / 32,
  q5_0: 22 / 32,
  q4_1: 20 / 32,
  q4_0: 18 / 32,
};

export interface KvReserveInput {
  blockCount?: number | undefined;
  embeddingLength?: number | undefined;
  headCount?: number | undefined;
  headCountKv?: number | undefined;
  keyLength?: number | undefined;
  valueLength?: number | undefined;
  /** Total launch context (`--ctx-size`, i.e. per-slot ctx × slots). */
  ctxTokens: number;
  /** The launcher's `--cache-type-k/v` value (assumed symmetric). */
  kvCacheType?: string | undefined;
}

/**
 * Estimate the KV cache's VRAM footprint at launch: under `-ngl all`
 * every layer's KV lives on the GPU. Full-attention assumption — models
 * with sliding-window layers (Gemma) allocate less than this, which only
 * biases the plan toward keeping more experts in RAM; never toward an
 * OOM. Returns undefined when the header lacks the needed dims (e.g.
 * per-layer KV-head arrays), so callers can budget weights-only rather
 * than on a guess.
 */
export function estimateKvReserveBytes(input: KvReserveInput): number | undefined {
  const { blockCount, headCountKv, ctxTokens } = input;
  if (!blockCount || !headCountKv || !ctxTokens) return undefined;
  const headDim =
    input.headCount && input.embeddingLength ? input.embeddingLength / input.headCount : undefined;
  const kDim = input.keyLength ?? headDim;
  const vDim = input.valueLength ?? headDim;
  if (!kDim || !vDim) return undefined;
  const bytesPerElement = KV_BYTES_PER_ELEMENT[input.kvCacheType ?? 'f16'] ?? 2;
  return Math.round(blockCount * ctxTokens * headCountKv * (kDim + vDim) * bytesPerElement);
}

export interface WindowedKvInput {
  blockCount?: number | undefined;
  embeddingLength?: number | undefined;
  headCount?: number | undefined;
  /** Scalar/mean KV heads — used for every layer when no per-layer array exists. */
  headCountKv?: number | undefined;
  /** Per-layer KV heads, index-aligned with `slidingWindowPattern` (Gemma 4). */
  headCountKvPerLayer?: number[] | undefined;
  /** SWA window size in tokens (`<arch>.attention.sliding_window`). */
  slidingWindow?: number | undefined;
  /** Per-layer flags: true = SWA layer, false = global layer. */
  slidingWindowPattern?: boolean[] | undefined;
  keyLength?: number | undefined;
  valueLength?: number | undefined;
  /** SWA-layer head dims when they differ from the global ones (Gemma 4: 256 vs 512). */
  keyLengthSwa?: number | undefined;
  valueLengthSwa?: number | undefined;
  kvCacheType?: string | undefined;
}

export interface WindowedKvLinearization {
  /**
   * KV bytes per context token per slot — global (full-attention) layers
   * only, the sole component that scales with the window.
   */
  bytesPerToken: number;
  /**
   * Context-independent KV bytes per slot: the SWA layers' window-capped
   * caches. Add to the resident-weights term when feeding a linear
   * admission model (`total(ctx) = fixed + bytesPerToken × ctx`).
   */
  fixedBytes: number;
}

/**
 * Tokens each SWA layer caches beyond the window itself — llama.cpp
 * allocates `n_swa + n_ubatch` per SWA layer. Sized for the largest
 * ubatch we launch with; overestimating here only pads the fixed term.
 */
const SWA_UBATCH_MARGIN_TOKENS = 2048;

/**
 * Price the DEFAULT (windowed) KV cache of a sliding-window-attention
 * model as a linear function of context: SWA layers cache only
 * ~`slidingWindow` tokens regardless of context (a fixed cost), while the
 * global layers scale with it. On Gemma 4 the two shapes differ by more
 * than the layer ratio — global layers carry fewer KV heads at wider head
 * dims (31b: 10 layers × 4 heads × 512+512 vs 50 layers × 16 heads ×
 * 256+256) — so full-attention math overstates the windowed cache ~14×
 * and using it for admission over-clamps or over-denies exactly the
 * launches the `--swa-full` decline is trying to keep whole (the
 * 2026-08-04 gemma4-26b sweep shipped 19–56K windows on a 65536 request
 * this way).
 *
 * Returns undefined when the header lacks the SWA layout (no window, no
 * pattern, length mismatches) so callers fall back to their conservative
 * path instead of guessing. `shared_kv_layers` (Gemma 4n) is deliberately
 * ignored — sharing only shrinks the real cache, so the estimate stays an
 * overestimate, never an OOM-side error.
 */
export function estimateWindowedKvLinearization(
  input: WindowedKvInput,
): WindowedKvLinearization | undefined {
  const { blockCount, slidingWindow, slidingWindowPattern } = input;
  if (!blockCount || !slidingWindow || slidingWindow <= 0 || !slidingWindowPattern)
    return undefined;
  if (slidingWindowPattern.length !== blockCount) return undefined;
  const headDim =
    input.headCount && input.embeddingLength ? input.embeddingLength / input.headCount : undefined;
  const kDim = input.keyLength ?? headDim;
  const vDim = input.valueLength ?? headDim;
  if (!kDim || !vDim) return undefined;
  const kDimSwa = input.keyLengthSwa ?? kDim;
  const vDimSwa = input.valueLengthSwa ?? vDim;
  const perLayerHeads = input.headCountKvPerLayer;
  if (perLayerHeads && perLayerHeads.length !== blockCount) return undefined;
  if (!perLayerHeads && !input.headCountKv) return undefined;
  const bytesPerElement = KV_BYTES_PER_ELEMENT[input.kvCacheType ?? 'f16'] ?? 2;
  let globalElemsPerToken = 0;
  let swaElemsPerToken = 0;
  for (let layer = 0; layer < blockCount; layer++) {
    const heads = perLayerHeads?.[layer] ?? input.headCountKv;
    if (!heads) return undefined;
    if (slidingWindowPattern[layer]) swaElemsPerToken += heads * (kDimSwa + vDimSwa);
    else globalElemsPerToken += heads * (kDim + vDim);
  }
  return {
    bytesPerToken: globalElemsPerToken * bytesPerElement,
    fixedBytes: Math.round(
      swaElemsPerToken * bytesPerElement * (slidingWindow + SWA_UBATCH_MARGIN_TOKENS),
    ),
  };
}
