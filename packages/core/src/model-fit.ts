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
