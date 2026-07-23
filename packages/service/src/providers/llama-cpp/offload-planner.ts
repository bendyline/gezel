/**
 * Hardware-aware MoE offload planner (Phase v2).
 *
 * The user's headline case: a big Mixture-of-Experts model on a
 * constrained discrete GPU (e.g. 12 GB VRAM + 64 GB system RAM). The
 * whole model won't fit in VRAM, but its *attention/dense* layers will
 * — the bulk is the sparse expert weights. b9843's `--cpu-moe` keeps
 * exactly those experts in system RAM (streamed per token) while every
 * attention layer stays on the GPU. That's dramatically better than the
 * engine's own `--fit`, which only knows how to DROP whole layers to
 * CPU.
 *
 * This planner makes the *binary* decision — "stream experts from RAM,
 * yes/no" — which is robust without precise per-tensor sizing. The
 * granular `--n-cpu-moe N` partial split is left as a manual knob
 * (v1's `llamaCppNCpuMoe`) until we can size expert layers exactly.
 *
 * Pure and deterministic → unit-tested. All I/O (VRAM probe, GGUF read)
 * happens in the caller, which passes plain numbers in.
 *
 * The returned shape is a subset of `PlannerOffloadDecision` from
 * `engine-flags.ts`, so it feeds straight into `buildLlamaCppEngineArgs`
 * as the lowest-precedence layer (global config + manifest still win).
 */

/** 1 GiB of headroom reserved for driver/OS/other-apps beyond the model. */
const DEFAULT_MARGIN_BYTES = 1024 ** 3;

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
}

export interface MoeOffloadDecision {
  /** `--n-gpu-layers` (−1 = all). Undefined = leave to the engine. */
  nGpuLayers?: number;
  /** `--cpu-moe` — keep all MoE experts in system RAM. */
  cpuMoe?: boolean;
  /** `--n-cpu-moe N` — partial split (reserved; unused in the v2 binary decision). */
  nCpuMoe?: number;
  /** Human-readable rationale for the decision log (never emitted as a flag). */
  reason?: string;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * Decide whether to stream a MoE model's experts from system RAM.
 *
 * - No GPU / unknown VRAM  → no decision (engine default).
 * - Dense model           → no decision (its `--fit`/`-ngl auto`
 *                            layer-dropping is the right tool).
 * - MoE that fits in VRAM  → no decision (full-GPU residency is fastest).
 * - MoE that won't fit     → `-ngl all --cpu-moe` (attention on GPU,
 *                            experts streamed from RAM).
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
