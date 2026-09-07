/**
 * Hardware-aware structured-weight offload planner (Phase v4 — dense FFN).
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
 * Dense models get the same treatment through llama.cpp v0.4.0's
 * `--n-cpu-ffn`: keep attention on the GPU and move only the first N
 * blocks' dense feed-forward weights to system RAM. This is materially
 * better than the engine's whole-layer fallback when a dense model is only
 * somewhat larger than VRAM, but it is enabled only on a discrete-GPU host
 * whose system-RAM budget can hold the selected prefix.
 *
 * When a plan is still too optimistic (KV estimates are coarse, other
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

export interface DenseFfnSplit {
  /** Bytes `--n-cpu-ffn` leaves on the GPU (attention, embeddings, norms, output). */
  nonFfnBytes: number;
  /** Dense FFN bytes per block, indexed by `blk.N`. */
  ffnBytesByLayer: number[];
}

export interface DenseFfnOffloadInput {
  /** Dense-FFN offload deliberately does not apply to MoE models. */
  isMoE: boolean;
  /** Largest single-GPU VRAM pool in bytes (0 = no discrete GPU). */
  vramBytes: number;
  /** Exact per-tensor dense-FFN/non-FFN sums from the GGUF header. */
  split?: DenseFfnSplit;
  /** `<arch>.block_count` — bounds `--n-cpu-ffn N`. */
  blockCount?: number;
  /** KV bytes resident on the GPU at the selected context and slot count. */
  kvReserveBytes?: number;
  /** Projector or other weights not represented by the primary GGUF split. */
  additionalGpuBytes?: number;
  /** Capacity-policy share of system RAM available to local engines. */
  ramBudgetBytes?: number;
  /** Live reclaimable system RAM. Used as a second, stricter safety gate. */
  freeSystemRamBytes?: number;
  /** Headroom to leave free in each memory pool; defaults to 1 GiB. */
  marginBytes?: number;
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
  /** `--n-cpu-ffn N` — keep blocks `0..N-1`'s dense FFN weights in RAM. */
  nCpuFfn?: number;
  /** Human-readable rationale for the decision log (never emitted as a flag). */
  reason?: string;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * Plan llama.cpp v0.4.0's dense-FFN split on suitable discrete-GPU hosts.
 *
 * There is intentionally no estimate-only fallback. The decision pins
 * `-ngl all`, so it must be based on the exact tensors the accompanying
 * override moves; an approximate split could turn the optimization into a
 * startup OOM. If the non-FFN GPU residue or the CPU prefix cannot fit its
 * respective pool, leave the launch to llama.cpp's conservative `--fit`
 * whole-layer strategy.
 */
export function planDenseFfnOffload(input: DenseFfnOffloadInput): MoeOffloadDecision {
  const margin = input.marginBytes ?? DEFAULT_MARGIN_BYTES;
  if (input.isMoE) return {};
  if (!input.vramBytes || input.vramBytes <= 0) {
    return { reason: 'no discrete GPU pool detected — leaving dense offload to the engine' };
  }
  if (!input.split || input.split.ffnBytesByLayer.length === 0) return {};

  const layers = input.split.ffnBytesByLayer;
  const blockCount = Math.max(input.blockCount ?? layers.length, layers.length);
  const ffnTotal = layers.reduce((sum, value) => sum + value, 0);
  if (ffnTotal <= 0 || blockCount <= 0) return {};

  const kvReserve = Math.max(0, input.kvReserveBytes ?? 0);
  const additionalGpu = Math.max(0, input.additionalGpuBytes ?? 0);
  const reserves = margin + kvReserve + COMPUTE_RESERVE_BYTES + additionalGpu;
  const weightsTotal = input.split.nonFfnBytes + ffnTotal;
  if (weightsTotal + reserves <= input.vramBytes) {
    return {
      reason: `dense model fits VRAM (weights ${gib(weightsTotal)} + reserves ${gib(reserves)} ≤ ${gib(input.vramBytes)}) — full GPU residency`,
    };
  }

  const ffnBudget = input.vramBytes - reserves - input.split.nonFfnBytes;
  if (ffnBudget < 0) {
    return {
      reason: `dense non-FFN residue ${gib(input.split.nonFfnBytes)} + reserves ${gib(reserves)} exceed VRAM ${gib(input.vramBytes)} — leaving whole-layer fit to the engine`,
    };
  }

  // `--n-cpu-ffn N` moves blocks 0..N-1 to CPU, so pack the largest
  // trailing suffix in VRAM and offload the prefix that remains.
  let gpuLayers = 0;
  let gpuFfnBytes = 0;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layerBytes = layers[i] ?? 0;
    if (gpuFfnBytes + layerBytes > ffnBudget) break;
    gpuFfnBytes += layerBytes;
    gpuLayers += 1;
  }
  const nCpuFfn = Math.max(0, blockCount - gpuLayers);
  if (nCpuFfn === 0) {
    return {
      reason: `all ${blockCount} dense FFN layers fit the ${gib(ffnBudget)} FFN budget — full GPU residency`,
    };
  }

  const cpuFfnBytes = layers
    .slice(0, Math.min(nCpuFfn, layers.length))
    .reduce((sum, value) => sum + value, 0);
  const ramLimit = Math.min(
    input.ramBudgetBytes ?? Number.POSITIVE_INFINITY,
    input.freeSystemRamBytes ?? Number.POSITIVE_INFINITY,
  );
  if (cpuFfnBytes + margin > ramLimit) {
    return {
      reason: `dense FFN split needs ${gib(cpuFfnBytes)} system RAM + ${gib(margin)} headroom, above the safe ${gib(ramLimit)} pool — leaving whole-layer fit to the engine`,
    };
  }

  return {
    nGpuLayers: -1,
    nCpuFfn,
    reason:
      `dense FFN of ${gpuLayers}/${blockCount} layers fits VRAM (${gib(gpuFfnBytes)} of ${gib(ffnTotal)}, ` +
      `non-FFN ${gib(input.split.nonFfnBytes)}, reserves ${gib(reserves)}) — --n-cpu-ffn ${nCpuFfn}`,
  };
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

/** Dense counterpart of {@link degradeMoeOffloadDecision}. */
export function degradeDenseFfnOffloadDecision(
  decision: MoeOffloadDecision | undefined,
  blockCount: number | undefined,
): MoeOffloadDecision | null {
  if (!decision || typeof decision.nCpuFfn !== 'number') return null;
  const allLayers = Math.max(blockCount ?? 0, decision.nCpuFfn);
  if (allLayers > decision.nCpuFfn) {
    return {
      nGpuLayers: -1,
      nCpuFfn: allLayers,
      reason: 'GPU OOM at launch — retrying with every dense FFN layer in system RAM (--n-cpu-ffn)',
    };
  }
  if (decision.nGpuLayers !== undefined) {
    return {
      nCpuFfn: decision.nCpuFfn,
      reason:
        'GPU OOM at launch — keeping dense FFN weights in RAM and leaving the GPU layer count to the engine',
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
  /**
   * Per-layer KV heads, index-aligned with `slidingWindowPattern`
   * (Gemma 4). When present (with the pattern and SWA dims), the estimate
   * becomes per-layer exact instead of mean-based.
   */
  headCountKvPerLayer?: number[] | undefined;
  /** Per-layer flags: true = SWA layer, which caches at the `*Swa` dims. */
  slidingWindowPattern?: boolean[] | undefined;
  /** Trailing logical layers that share earlier K/V and own no cache tensors. */
  sharedKvLayers?: number | undefined;
  /**
   * `<arch>.num_loops` — a looped transformer runs the block stack this many
   * times over shared weights, each pass keeping its OWN KV cache (llama.cpp
   * unrolls them into `n_layer`). Multiplies every per-token KV quantity.
   * Absent / 1 on ordinary models.
   */
  loopCount?: number | undefined;
  keyLength?: number | undefined;
  valueLength?: number | undefined;
  /** SWA-layer head dims when they differ from the global ones (Gemma 4: 256 vs 512). */
  keyLengthSwa?: number | undefined;
  valueLengthSwa?: number | undefined;
  /**
   * `<arch>.full_attention_interval` — linear-attention hybrids
   * (`qwen35moe`) make only every Nth layer full attention; the rest keep
   * a context-independent recurrent state. Counting all layers as
   * KV-scaling overstates a 40-layer/interval-4 model 4x.
   */
  fullAttentionInterval?: number | undefined;
  /** `<arch>.ssm.*` — recurrent-state geometry on the linear layers. */
  ssmInnerSize?: number | undefined;
  ssmStateSize?: number | undefined;
  ssmConvKernel?: number | undefined;
  /** Total launch context (`--ctx-size`, i.e. per-slot ctx × slots). */
  ctxTokens: number;
  /** The launcher's `--cache-type-k/v` value (assumed symmetric). */
  kvCacheType?: string | undefined;
}

/**
 * Estimate the KV cache footprint with every cache-owning layer caching the
 * full context — what llama.cpp allocates for ordinary full-attention
 * models, and for SWA models under `--swa-full`. Trailing shared-KV layers
 * reuse an earlier cache and therefore contribute no allocation of their own.
 *
 * Per-layer exact when the header supplies the layout: SWA layers cache
 * at their own head dims (`key/value_length_swa`), so pricing them at the
 * global dims overstated Gemma 4's true `--swa-full` allocation ~2×
 * (31b at 64K: ~55 GB real vs ~105 GB mean-based) — enough to decline
 * the full cache on machines that could genuinely hold it. Falls back to
 * mean heads × global dims when per-layer data is absent, and to
 * undefined when even that is missing, so callers budget weights-only
 * rather than on a guess. For the DEFAULT (windowed) cache of an SWA
 * model, use {@link estimateWindowedKvLinearization} instead.
 */
export function estimateKvReserveBytes(input: KvReserveInput): number | undefined {
  const { blockCount, headCountKv, ctxTokens } = input;
  if (!blockCount || !ctxTokens) return undefined;
  const cacheLayerCount = cacheOwningLayerCount(blockCount, input.sharedKvLayers);
  const headDim =
    input.headCount && input.embeddingLength ? input.embeddingLength / input.headCount : undefined;
  const kDim = input.keyLength ?? headDim;
  const vDim = input.valueLength ?? headDim;
  if (!kDim || !vDim) return undefined;
  const bytesPerElement = KV_BYTES_PER_ELEMENT[input.kvCacheType ?? 'f16'] ?? 2;
  const loops = kvLoopMultiplier(input.loopCount);
  const perLayerHeads = input.headCountKvPerLayer;
  const pattern = input.slidingWindowPattern;
  if (
    pattern &&
    pattern.length === blockCount &&
    (!perLayerHeads || perLayerHeads.length === blockCount) &&
    (perLayerHeads || headCountKv)
  ) {
    const kDimSwa = input.keyLengthSwa ?? kDim;
    const vDimSwa = input.valueLengthSwa ?? vDim;
    let elemsPerToken = 0;
    for (let layer = 0; layer < cacheLayerCount; layer++) {
      const heads = perLayerHeads?.[layer] ?? headCountKv ?? 0;
      elemsPerToken += heads * (pattern[layer] ? kDimSwa + vDimSwa : kDim + vDim);
    }
    return Math.round(elemsPerToken * ctxTokens * bytesPerElement * loops);
  }
  if (!headCountKv) return undefined;
  // Linear-attention hybrids: only the full-attention layers hold a cache
  // that grows with context. Deliberately slope-only (no recurrent-state
  // term) because callers derive bytes-per-token by dividing this by a
  // reference context — folding a fixed cost in there would inflate the
  // slope. The fixed part belongs to the linearization below.
  const scalingLayers = fullAttentionLayerCount(cacheLayerCount, input.fullAttentionInterval);
  return Math.round(
    scalingLayers * ctxTokens * headCountKv * (kDim + vDim) * bytesPerElement * loops,
  );
}

/**
 * llama.cpp's Gemma 4 loader sets `n_layer_kv_from_start` to logical layers
 * minus `shared_kv_layers`: the trailing shared layers reuse the last K/V of
 * their attention type and do not allocate their own cache tensors.
 */
/**
 * KV multiplier for a looped transformer. Deliberately NOT folded into
 * {@link cacheOwningLayerCount}: that count also bounds the per-layer loops
 * that index `slidingWindowPattern` / `headCountKvPerLayer`, which are arrays
 * of LOGICAL layers — multiplying it there would read off the end. The loops
 * replay the same logical stack, so the honest place to apply the factor is
 * the per-token total each estimator returns.
 */
function kvLoopMultiplier(loopCount: number | undefined): number {
  return typeof loopCount === 'number' && Number.isFinite(loopCount) && loopCount > 1
    ? Math.floor(loopCount)
    : 1;
}

function cacheOwningLayerCount(blockCount: number, sharedKvLayers: number | undefined): number {
  const shared =
    typeof sharedKvLayers === 'number' && Number.isFinite(sharedKvLayers)
      ? Math.max(0, Math.min(blockCount, Math.floor(sharedKvLayers)))
      : 0;
  return blockCount - shared;
}

/**
 * Layers whose KV grows with the context window. Every layer on an
 * ordinary model; every `interval`-th layer on a linear-attention hybrid
 * (llama.cpp marks layer `i` full-attention when `(i + 1) % interval == 0`,
 * so 40 layers at interval 4 gives 10).
 */
function fullAttentionLayerCount(blockCount: number, interval: number | undefined): number {
  if (!interval || interval <= 1) return blockCount;
  let n = 0;
  for (let layer = 0; layer < blockCount; layer++) if ((layer + 1) % interval === 0) n++;
  return n > 0 ? n : blockCount;
}

/**
 * Bytes one linear-attention layer holds per slot, independent of context:
 * a short causal-conv window plus the recurrent state. Approximate — the
 * exact allocation is engine-internal — and biased high (f32 state, which
 * is what `mamba_ssm_dtype` asks for) so the estimate never under-reserves.
 * Returns 0 when the header omits the SSM geometry, which only makes the
 * estimate more conservative in the direction that matters: the term is
 * tens of MB against weights measured in GB.
 */
function linearLayerStateBytes(input: {
  ssmInnerSize?: number | undefined;
  ssmStateSize?: number | undefined;
  ssmConvKernel?: number | undefined;
}): number {
  const inner = input.ssmInnerSize;
  if (!inner) return 0;
  const conv = input.ssmConvKernel ? inner * Math.max(0, input.ssmConvKernel - 1) : 0;
  const recurrent = input.ssmStateSize ? inner * input.ssmStateSize : 0;
  return (conv + recurrent) * 4;
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
  /** Trailing logical layers that share earlier K/V and own no cache tensors. */
  sharedKvLayers?: number | undefined;
  /**
   * `<arch>.num_loops` — a looped transformer runs the block stack this many
   * times over shared weights, each pass keeping its OWN KV cache (llama.cpp
   * unrolls them into `n_layer`). Multiplies every per-token KV quantity.
   * Absent / 1 on ordinary models.
   */
  loopCount?: number | undefined;
  keyLength?: number | undefined;
  valueLength?: number | undefined;
  /** SWA-layer head dims when they differ from the global ones (Gemma 4: 256 vs 512). */
  keyLengthSwa?: number | undefined;
  valueLengthSwa?: number | undefined;
  /**
   * `<arch>.full_attention_interval` — linear-attention hybrids
   * (`qwen35moe`) make only every Nth layer full attention; the rest keep
   * a context-independent recurrent state. Counting all layers as
   * KV-scaling overstates a 40-layer/interval-4 model 4x.
   */
  fullAttentionInterval?: number | undefined;
  /** `<arch>.ssm.*` — recurrent-state geometry on the linear layers. */
  ssmInnerSize?: number | undefined;
  ssmStateSize?: number | undefined;
  ssmConvKernel?: number | undefined;
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
 * path instead of guessing. Shared trailing KV layers are excluded exactly:
 * llama.cpp does not allocate cache tensors for them.
 */
/**
 * Exact per-slot KV bytes at f16 for the slot-ceiling math: the windowed
 * linearization when the header shows an SWA layout (the engine-default
 * cache mode, and the one that yields the honest slot upper bound — a
 * full-attention number would cut Gemma to one slot for a cache it only
 * runs when it fits anyway), per-layer full-attention otherwise.
 * Undefined when the header lacks the dims; callers fall back to the
 * weights-scaled heuristic.
 */
export function estimateExactPerSlotKvBytesF16(
  input: Omit<WindowedKvInput, 'kvCacheType'>,
  perTurnCtxTokens: number,
): number | undefined {
  const windowed = estimateWindowedKvLinearization({ ...input, kvCacheType: 'f16' });
  if (windowed) {
    return Math.round(windowed.fixedBytes + windowed.bytesPerToken * perTurnCtxTokens);
  }
  const hybrid = estimateLinearHybridKvLinearization({ ...input, kvCacheType: 'f16' });
  if (hybrid) {
    return Math.round(hybrid.fixedBytes + hybrid.bytesPerToken * perTurnCtxTokens);
  }
  return estimateKvReserveBytes({
    ...input,
    ctxTokens: perTurnCtxTokens,
    kvCacheType: 'f16',
  });
}

/**
 * Price a linear-attention hybrid (`qwen35moe`: Qwen 3.5 MoE, Ornith,
 * BTL-4) as `fixed + slope × ctx`, the same shape the SWA linearization
 * returns and the same shape `planCtxTokensForMemory` consumes.
 *
 * Only the full-attention layers scale with the window; the linear layers
 * carry a recurrent state whose size does not depend on context at all.
 * A 40-layer model at interval 4 therefore caches 10 layers, not 40 —
 * ~20 KB/token instead of ~80 KB/token, which is a 4x difference on the
 * exact models whose selling point is a cheap 256K context. Pricing them
 * as full attention would clamp or deny windows the engine holds easily.
 *
 * Returns undefined when the header shows no interval (ordinary models)
 * or lacks the dims, so callers fall back to full-attention math.
 */
export function estimateLinearHybridKvLinearization(
  input: WindowedKvInput,
): WindowedKvLinearization | undefined {
  const { blockCount, fullAttentionInterval, headCountKv } = input;
  if (!blockCount || !fullAttentionInterval || fullAttentionInterval <= 1) return undefined;
  if (!headCountKv) return undefined;
  const headDim =
    input.headCount && input.embeddingLength ? input.embeddingLength / input.headCount : undefined;
  const kDim = input.keyLength ?? headDim;
  const vDim = input.valueLength ?? headDim;
  if (!kDim || !vDim) return undefined;
  const bytesPerElement = KV_BYTES_PER_ELEMENT[input.kvCacheType ?? 'f16'] ?? 2;
  const loops = kvLoopMultiplier(input.loopCount);
  const scalingLayers = fullAttentionLayerCount(blockCount, fullAttentionInterval);
  const linearLayers = blockCount - scalingLayers;
  return {
    bytesPerToken: scalingLayers * headCountKv * (kDim + vDim) * bytesPerElement * loops,
    fixedBytes: Math.round(linearLayers * linearLayerStateBytes(input) * loops),
  };
}

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
  const loops = kvLoopMultiplier(input.loopCount);
  const cacheLayerCount = cacheOwningLayerCount(blockCount, input.sharedKvLayers);
  let globalElemsPerToken = 0;
  let swaElemsPerToken = 0;
  for (let layer = 0; layer < cacheLayerCount; layer++) {
    const heads = perLayerHeads?.[layer] ?? input.headCountKv;
    if (!heads) return undefined;
    if (slidingWindowPattern[layer]) swaElemsPerToken += heads * (kDimSwa + vDimSwa);
    else globalElemsPerToken += heads * (kDim + vDim);
  }
  return {
    bytesPerToken: globalElemsPerToken * bytesPerElement * loops,
    fixedBytes: Math.round(
      swaElemsPerToken * bytesPerElement * (slidingWindow + SWA_UBATCH_MARGIN_TOKENS) * loops,
    ),
  };
}

export interface SwaFullFastMemoryFitInput {
  residentWeightsBytes: number;
  fullKvBytes: number;
  /** Already safety-discounted fast-memory budget (VRAM on a discrete GPU). */
  fastBudgetBytes: number;
  /** Fast-memory reservations held by models that are already resident. */
  committedOtherBytes?: number | undefined;
}

/**
 * Whether Auto may keep `--swa-full` without spilling the model or KV cache
 * out of the fast pool. The capacity budget already reserves driver/OS
 * headroom, so this comparison must not discount it a second time.
 */
export function fitsSwaFullInFastMemory(input: SwaFullFastMemoryFitInput): boolean {
  const required = Math.max(0, input.residentWeightsBytes) + Math.max(0, input.fullKvBytes);
  const available = Math.max(
    0,
    input.fastBudgetBytes - Math.max(0, input.committedOtherBytes ?? 0),
  );
  return Number.isFinite(required) && Number.isFinite(available) && required <= available;
}
