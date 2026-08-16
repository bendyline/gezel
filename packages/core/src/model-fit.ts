/**
 * "Will this model run well on this machine?" — a hardware-fit tier for
 * a chat model, used to badge/rank models in the install browser and the
 * installed list.
 *
 * The key improvement over a naive `size > budget` check is **MoE
 * awareness**. A big Mixture-of-Experts model (e.g. a 35B-A3B at ~20 GB)
 * won't fit a 12 GB discrete GPU by raw size, but its sparse expert
 * weights can stream from system RAM (`--cpu-moe`) while attention runs
 * on the GPU — so it runs fine on a 12 GB card + 64 GB RAM. A naive
 * check labels it "may not fit"; this one labels it "runs (expert
 * offload)", which is exactly the "prefer MoE that fits" guidance.
 *
 * Pure and deterministic → unit-tested. The caller supplies the model's
 * estimated footprint and the machine's memory profile (both already
 * available from the catalog manifest + `/api/system/memory`).
 */

/**
 * Proportional term: the weight buffers llama.cpp actually allocates, as a
 * ratio of the GGUF on disk. Measured 2026-08-15 on Vulkan/AMD from
 * llama.cpp's own `load_tensors: … model buffer size` accounting, summed
 * across devices (so it is offload-independent) and corroborated against
 * the OS GPU dedicated-memory counter:
 *
 *   qwen3.6-27b-q4      16314 MiB file → 16028 MiB buffers   0.98×
 *   qwen3.8-27b-q4      16314 MiB file → 16028 MiB buffers   0.98×
 *   qwen3.6-35b-a3b-q4  21614 MiB file → 21099 MiB buffers   0.98×
 *   gemma4-e4b-q4        4020 MiB file →  4365 MiB buffers   1.09×
 *
 * Three of four land BELOW the file size — nothing decompresses on load,
 * and the shortfall is GGUF metadata that never becomes a tensor. The 1.09
 * is gemma4-E4B's per-layer embeddings: real architecture variance rather
 * than a fixed cost, so the proportional term sits just above that worst
 * case instead of at the 0.98 the dense models alone would justify.
 */
export const LLAMA_CPP_WEIGHTS_MULTIPLIER = 1.1;

/**
 * Fixed term: compute + output buffers, which llama.cpp sizes from the
 * batch and the vocab, NOT from the weights. Measured at 86–164 MiB across
 * that same 3.9→21 GB span — i.e. flat, which is why a single multiplier
 * fit nothing: it under-described a 4 GB model and over-reserved a 21 GB
 * one by ~3 GB.
 */
export const LLAMA_CPP_FIXED_ENGINE_BYTES = 256 * 1024 ** 2;

/**
 * Resident llama.cpp footprint for a GGUF of `approxSizeBytes`, KV
 * EXCLUDED — every caller prices KV explicitly on top.
 *
 * Replaces a flat `× 1.2` that predated KV being priced separately. On a
 * 27B it reserved 19.1 GiB against a measured 15.8 GiB, and that 3.3 GiB
 * came straight out of the context clamp's KV allowance.
 *
 * Still deliberately biased high: under-reserving pages the whole desktop
 * (the 2026-08-03 incident), while over-reserving only makes sessions
 * compact sooner. The margin is now ~10% on a large dense model, not ~21%.
 *
 * Lives in core because the daemon's admission path and the UI's fit badge
 * must agree — a fit computed from a different number offers models the
 * broker then refuses.
 */
/**
 * Extra fixed cost once a multimodal projector is loaded: llama.cpp reserves a
 * second set of compute buffers for the vision graph, sized from the image
 * batch rather than from the projector. Measured at 292.30 MiB (Metal) + 73.27
 * MiB (CPU) = 366 MiB on muse-glimmer-30b-q4, the one mmproj-bearing GGUF
 * installed when this was measured; 384 sits just above it.
 *
 * Only one model's worth of evidence, so it is deliberately a flat term rather
 * than anything derived — an image batch is the same shape whatever the
 * projector weighs.
 */
export const LLAMA_CPP_VISION_COMPUTE_BYTES = 384 * 1024 ** 2;

/**
 * Resident llama.cpp footprint. `mmprojBytes` is the multimodal projector's
 * on-disk size, which is NOT part of `approxSizeBytes` — the installed
 * manifest counts the GGUF alone, so a vision model that loads a 1.3 GiB
 * projector was reserved as if it were text-only. Measured on
 * muse-glimmer-30b-q4: loading the projector moved RSS by 1698 MiB against a
 * 1335 MiB file, the remainder being the vision compute buffers above.
 *
 * The projector is weights-like — tensors llama.cpp buffers the same way — so
 * it rides the same proportional term rather than getting one of its own.
 */
export function estimateLlamaCppResidentBytes(
  approxSizeBytes: number,
  opts?: { mmprojBytes?: number },
): number {
  const mmprojBytes = opts?.mmprojBytes ?? 0;
  return (
    Math.round((approxSizeBytes + mmprojBytes) * LLAMA_CPP_WEIGHTS_MULTIPLIER) +
    LLAMA_CPP_FIXED_ENGINE_BYTES +
    (mmprojBytes > 0 ? LLAMA_CPP_VISION_COMPUTE_BYTES : 0)
  );
}

/**
 * Proportional term for MLX. Measured 2026-08-15 on an M5 Max from
 * `mx.get_active_memory()` immediately after `mlx_vlm.utils.load` and before
 * any inference — so weights only, no KV, no activations:
 *
 *   lfm2.5-2.6b-q4        1.43 GiB file → 0.9883× active
 *   gemma4-12b-q4        10.26 GiB file → 0.9973×
 *   qwen3.8-27b-q4       14.98 GiB file → 0.9984×
 *   qwen3.6-27b-q8       27.50 GiB file → 0.9991×
 *   qwen3.6-35b-a3b-q8   35.16 GiB file → 0.9993×
 *   laguna-s-2.1-118b-q6 86.15 GiB file → 0.9999×
 *
 * MLX allocates the weights and essentially nothing else — every sample sits
 * at or below 1.0, and the shortfall is safetensors metadata plus the
 * tokenizer files that `approxSizeBytes` counts and no tensor ever holds. The
 * 1.02 is architecture margin, not observed cost.
 */
export const MLX_WEIGHTS_MULTIPLIER = 1.02;

/**
 * Fixed term for MLX: the sidecar process itself — Python, the MLX runtime,
 * mlx_vlm/transformers, and the tokenizer — measured at 376–875 MiB across
 * that same 1.4→86 GiB span. Flat over a 60× range, which is what makes a
 * bare multiplier the wrong shape here: the old `× 1.05` under-reserved a
 * 1.4 GiB model by 633 MiB while wasting 1.1 GiB on a 35 GiB one.
 */
export const MLX_FIXED_ENGINE_BYTES = 1024 * 1024 ** 2;

/**
 * Resident MLX footprint for a model of `approxSizeBytes`, KV EXCLUDED —
 * every caller prices KV explicitly on top.
 *
 * Same fixed-plus-proportional shape as {@link estimateLlamaCppResidentBytes}
 * and for the same reason: the cost that does not scale with the weights has
 * to be carried by a term that does not scale either.
 */
export function estimateMlxResidentBytes(approxSizeBytes: number): number {
  return Math.round(approxSizeBytes * MLX_WEIGHTS_MULTIPLIER) + MLX_FIXED_ENGINE_BYTES;
}

export type ModelFitTier = 'fits' | 'fits-offload' | 'tight' | 'too-big';

export interface ModelFitInput {
  /** Estimated GPU/host working set: on-disk size × overhead (KV, activations). */
  residentBytes: number;
  /** Mixture-of-Experts model — its experts can stream from system RAM. */
  isMoE: boolean;
  /** The fast memory budget: VRAM on a discrete GPU, a RAM fraction on unified/CPU. */
  usableBytes: number;
  /** Total system RAM in bytes. */
  totalRamBytes: number;
  /** Discrete GPU VRAM in bytes, or null on unified-memory / CPU-only machines. */
  gpuVramBytes: number | null;
  /**
   * What the capacity broker will actually admit on this machine
   * (`/api/system/memory` → `budgetBytes`). Anything above it is refused at
   * load time, so it — not a raw fraction of RAM — is where `too-big` starts.
   *
   * Optional for callers that predate the field; they keep the old
   * {@link RAM_OFFLOAD_FRACTION} ceiling, which on a discrete-GPU host
   * over-promised: it offered a 42 GB MoE against 80% of system RAM while
   * the broker's budget stopped at 60%, so the download succeeded and the
   * load did not.
   */
  admissibleBytes?: number;
  /**
   * Bytes `--cpu-moe` leaves GPU-resident (attention, dense/shared layers,
   * embeddings) — from the installed GGUF's tensor table, when scanned.
   * Absent (browse-time, pre-download) the check falls back to
   * {@link MOE_NON_EXPERT_FRACTION_ESTIMATE} of `residentBytes`.
   */
  nonExpertBytes?: number;
}

export interface ModelFitResult {
  tier: ModelFitTier;
  /** Short pill label. */
  label: string;
  /** Longer tooltip explanation. */
  detail: string;
  /** True when the model can run at all (tier !== 'too-big'). */
  runnable: boolean;
}

/** Headroom left in system RAM (OS + other apps) when experts stream from RAM. */
const RAM_OFFLOAD_FRACTION = 0.8;

/**
 * Browse-time estimate of the non-expert share of a MoE's footprint —
 * what `--cpu-moe` keeps on the GPU. Measured GGUFs run 5–10% for
 * DeepSeek-class giants and ~10–20% for consumer-size MoEs; 15% sits at
 * the honest end without gating out the machines full offload does serve
 * (a 4 GB card still clears a 26B-A4B). The exact per-tensor figure
 * replaces this whenever the caller has scanned the installed GGUF.
 */
export const MOE_NON_EXPERT_FRACTION_ESTIMATE = 0.15;

/**
 * The working window Gezel guarantees a local chat model on a host with room
 * to spare. Tool loops, a project brief, and a few file reads spend most of a
 * 32K window before the user's second question, so this is the floor admission
 * defends by shedding engine slots rather than shortening context.
 */
export const LOCAL_CONTEXT_FLOOR_TOKENS = 65_536;

/**
 * The same floor on a memory-constrained host ({@link isMemoryConstrainedMachine}).
 * Half a working window still runs agentic loops — sessions just compact
 * sooner — while insisting on 64K there denies the launch outright: the KV at
 * 64K is what pushes a small machine past its budget, and a denial gives the
 * user nothing at all.
 */
export const CONSTRAINED_LOCAL_CONTEXT_FLOOR_TOKENS = 32_768;

/**
 * System RAM at or below which a unified-memory or CPU-only host counts as
 * memory-constrained. On those hosts the KV cache competes with the OS, the
 * Electron shell, and the weights for the same pool.
 */
export const CONSTRAINED_HOST_RAM_BYTES = 16 * 1024 ** 3;

/**
 * Usable VRAM at or below which a discrete card counts as memory-constrained.
 * Compared against the USABLE figure (~95% of the card), so an 8 GB card lands
 * under the line and a 10 GB one does not.
 */
export const CONSTRAINED_HOST_VRAM_BYTES = 8 * 1024 ** 3;

/** The memory shape of a host, as much of it as the context floor depends on. */
export interface MachineMemoryShape {
  totalRamBytes: number;
  /** Usable VRAM on a discrete card; null on unified / integrated / CPU-only hosts. */
  gpuVramBytes: number | null;
}

/**
 * Whether this host has to trade context for memory. A discrete card is judged
 * on VRAM alone — that is where its KV lives, so a 24 GB card next to 16 GB of
 * system RAM is not context-constrained. Everything else (Apple Silicon,
 * integrated GPUs, CPU-only) is judged on system RAM, the one pool it has.
 */
export function isMemoryConstrainedMachine(machine: MachineMemoryShape): boolean {
  const vram = machine.gpuVramBytes;
  if (vram !== null && vram > 0) return vram <= CONSTRAINED_HOST_VRAM_BYTES;
  return machine.totalRamBytes > 0 && machine.totalRamBytes <= CONSTRAINED_HOST_RAM_BYTES;
}

/**
 * The context floor to hold this host to. The single derivation both the
 * daemon's admission ladder and the install browser's fit badges read, so a
 * model is never badged against a window admission would not have asked for.
 */
export function localContextFloorTokens(machine?: MachineMemoryShape | null): number {
  return machine && isMemoryConstrainedMachine(machine)
    ? CONSTRAINED_LOCAL_CONTEXT_FLOOR_TOKENS
    : LOCAL_CONTEXT_FLOOR_TOKENS;
}

/**
 * The working window fit badges price KV at when the caller knows nothing
 * about the host. Prefer {@link localContextFloorTokens} with the machine's
 * memory profile — a constrained host launches at half this.
 */
export const FIT_KV_CONTEXT_TOKENS = LOCAL_CONTEXT_FLOOR_TOKENS;

/**
 * KV bytes a model would carry at the fit window, from the catalog's
 * authored f16 geometry (`kvBytesPerTokenF16` / `kvFixedBytesF16`).
 * Returns 0 when the manifest predates the fields — the fit check then
 * degrades to the historical weights-only estimate rather than blocking.
 * `cacheScale` converts the f16 baseline to the engine's cache dtype
 * (llama.cpp defaults to q8_0 ≈ 0.55; MLX runs f16 = 1).
 */
export function estimateManifestKvBytes(
  manifest: { kvBytesPerTokenF16?: number; kvFixedBytesF16?: number },
  opts?: { ctxTokens?: number; cacheScale?: number },
): number {
  const perToken = manifest.kvBytesPerTokenF16;
  if (perToken === undefined || perToken <= 0) return 0;
  const ctx = opts?.ctxTokens ?? FIT_KV_CONTEXT_TOKENS;
  const scale = opts?.cacheScale ?? 0.55;
  return Math.round((perToken * ctx + (manifest.kvFixedBytesF16 ?? 0)) * scale);
}

/**
 * Classify a model's fit against a machine's memory. See the module
 * doc for the MoE-offload rationale.
 */
export function computeModelFit(input: ModelFitInput): ModelFitResult {
  const { residentBytes, isMoE, usableBytes, totalRamBytes, gpuVramBytes } = input;
  const ramBudget = input.admissibleBytes ?? totalRamBytes * RAM_OFFLOAD_FRACTION;

  // Fits in the fast budget — fully GPU-resident on a discrete card, or
  // within the RAM fraction on a unified-memory / CPU machine.
  if (residentBytes <= usableBytes) {
    return {
      tier: 'fits',
      label: gpuVramBytes != null ? 'fits in VRAM' : 'fits in memory',
      detail: 'Runs fully within the fast memory budget.',
      runnable: true,
    };
  }

  // MoE on a discrete GPU: bigger than VRAM, but the sparse experts can
  // stream from system RAM while attention stays on the GPU. Runnable as
  // long as the whole model fits in RAM — and only worth the "runs"
  // promise when the always-active residue actually fits VRAM, else the
  // engine has to spill layers to the CPU too and it belongs in `tight`.
  if (isMoE && gpuVramBytes != null && residentBytes <= ramBudget) {
    const residueBytes = input.nonExpertBytes ?? residentBytes * MOE_NON_EXPERT_FRACTION_ESTIMATE;
    if (residueBytes <= usableBytes) {
      return {
        tier: 'fits-offload',
        label: 'runs (expert offload)',
        detail:
          'Larger than VRAM, but this is a Mixture-of-Experts model — its experts stream from system RAM while attention runs on the GPU.',
        runnable: true,
      };
    }
    return {
      tier: 'tight',
      label: 'may run slowly',
      detail:
        'A Mixture-of-Experts model, but even its always-active layers exceed this GPU — parts run from system RAM on the CPU, so expect slower generation.',
      runnable: true,
    };
  }

  // Fits in system RAM but not the fast budget — runs, but slower (a dense
  // model paging from RAM, or a MoE with no GPU to offload onto).
  if (residentBytes <= ramBudget) {
    return {
      tier: 'tight',
      label: 'may run slowly',
      detail: 'Exceeds the fast memory budget but fits in system RAM — expect slower generation.',
      runnable: true,
    };
  }

  return {
    tier: 'too-big',
    label: 'may not fit',
    detail: 'Larger than this machine can hold — it may fail to load or run out of memory.',
    runnable: false,
  };
}

/**
 * Best-effort Mixture-of-Experts detection from a model's catalog tags,
 * for browse-time (pre-install, no GGUF on disk). The catalog tags MoE
 * models inconsistently — `moe`, `mix of experts`, `mixture of experts`
 * — so we normalize all of them. Once installed, the GGUF's
 * `expert_count` is the ground truth (see the offload planner).
 */
export function isMoEFromTags(tags: readonly string[] | undefined): boolean {
  if (!tags) return false;
  return tags.some((t) => {
    const l = t.toLowerCase();
    return l === 'moe' || l.includes('expert');
  });
}
