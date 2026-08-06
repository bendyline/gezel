/**
 * First-run / on-device model RECOMMENDATION picker.
 *
 * Chooses which recommended model to install on a given machine. A model is a
 * "recommendation candidate" only if it passes {@link isRecommendedModel} —
 * the same gate the ★ Recommended badge uses, enforced here so a stray score
 * on a restricted or tool-less model is never auto-installed.
 *
 * Among the candidates that comfortably fit the machine, the pick is by:
 *   1. `recoScore` (higher wins — the curated preference, e.g. Qwen over Gemma),
 *   2. MoE-alignment (see below),
 *   3. size (largest that still fits — "the highest model that comfortably fits").
 *
 * One usability floor runs before that ranking: non-Mac CPU/integrated hosts
 * and discrete GPUs below 8 GiB get the smallest curated candidate. Combined
 * RAM+VRAM admission can make a large MoE load there, but it is effectively
 * CPU-paced and is not a functional first-run default. High-throughput
 * unified accelerators such as DGX Spark are explicitly exempt.
 *
 * MoE-alignment encodes the expert-offload trade-off:
 *   - A big discrete GPU (> 24 GB VRAM, Windows/Linux) has room to run a dense
 *     model fully in VRAM — MoE offload buys nothing there, so MoE models are
 *     EXCLUDED (dense preferred outright).
 *   - Apple Silicon (unified memory) and smaller discrete GPUs (≤ 24 GB) gain
 *     from streaming MoE experts out of system RAM, so MoE models are PREFERRED
 *     (they outrank an equally-scored dense model).
 *   - CPU-only and consumer-iGPU hosts take the small-model usability floor
 *     above instead of selecting by technical loadability alone.
 *
 * Pure + deterministic → unit-tested. The service supplies the catalog
 * candidates (with provider-appropriate `residentBytes`) and the live memory
 * profile; the UI badge reuses `isRecommendedModel` alone.
 */
import { computeModelFit, isMoEFromTags } from './model-fit.js';

const GB = 1024 ** 3;

/**
 * The fields the recommendation gate reads — the structural subset every
 * model manifest satisfies, so the same predicate covers chat, image, video
 * and audio entries.
 */
export interface RecoGateInput {
  /** Hand-curated recommendation weight; absent → never recommended. */
  recoScore?: number;
  /** Only `'open'` models are ever recommended. */
  licenseClass?: string;
  /** Chat models declare this; media manifests have no such field. */
  supportsTools?: boolean;
}

/**
 * The single "would we recommend this model?" gate. The first-run picker
 * below, the ★ Recommended badge, the CLI bootstrap and the media pickers all
 * call this so they can never drift apart.
 *
 * Three conditions:
 *   1. a hand-curated positive `recoScore` — absent means no one nominated it;
 *   2. a fully-open license, so a stray score on a restricted model is ignored;
 *   3. tool support. Gezels do their work THROUGH the MCP toolset, so a model
 *      that cannot call tools is never a sane default no matter how good its
 *      prose is — it stays installable, but choosing it has to be the user's
 *      deliberate act, not ours.
 *
 * Media manifests carry no `supportsTools` field, hence `!== false` rather
 * than `=== true`: undefined passes, only an explicit refusal disqualifies.
 */
export function isRecommendedModel(m: RecoGateInput): boolean {
  return (
    typeof m.recoScore === 'number' &&
    m.recoScore > 0 &&
    m.licenseClass === 'open' &&
    m.supportsTools !== false
  );
}

/**
 * A discrete GPU with more than this much VRAM runs a dense model fully
 * resident, so MoE expert-offload is a downgrade — skip MoE candidates.
 */
export const DENSE_ONLY_VRAM_THRESHOLD = 24 * GB;

export interface RecoModelInput extends RecoGateInput {
  id: string;
  /** Catalog tags — MoE-ness is read from these via `isMoEFromTags`. */
  tags?: readonly string[];
  /** Provider-appropriate working set (manifest `residentBytes`, or on-disk × overhead). */
  residentBytes: number;
  /** Exact GPU-resident residue under `--cpu-moe`, when the GGUF has been scanned. */
  nonExpertBytes?: number;
}

export interface RecoDevice {
  platform: string;
  /** GPU-addressable memory in bytes, or null when no accelerator was detected. */
  gpuVramBytes: number | null;
  /**
   * How that GPU memory relates to system RAM. Optional for compatibility
   * with older daemons/callers; absent values are inferred from
   * `gpuVramBytes` as far as possible.
   *
   * `integrated` is the consumer iGPU/UMA case where a Vulkan adapter may
   * advertise part of system RAM as device memory. `unified` is reserved for
   * high-throughput unified accelerators such as Apple Silicon and NVIDIA
   * GB10/DGX Spark, which must not be collapsed onto the CPU-only path.
   */
  gpuMemoryKind?: 'discrete' | 'integrated' | 'unified' | 'none' | 'unknown';
  totalRamBytes: number;
  /** The fast memory budget (VRAM on a discrete card, a RAM fraction otherwise). */
  usableBytes: number;
  /**
   * What the capacity broker will admit across every pool — `budgetBytes`
   * from `/api/system/memory`. Optional so older callers keep working; when
   * present it becomes the runnable ceiling, so we never recommend a model
   * the daemon then refuses to load.
   */
  budgetBytes?: number;
}

export interface RecoPick {
  id: string;
  recoScore: number;
  /** One-line human-readable rationale (logged + surfaced to the user). */
  reason: string;
}

/**
 * Below 8 GiB, a discrete card cannot keep even a useful medium local model
 * resident. Expert offload may make a much larger MoE technically load, but
 * decode is then paced by system RAM/CPU and is not a functional first-run
 * recommendation.
 */
export const SMALL_MODEL_VRAM_THRESHOLD = 8 * GB;

/**
 * Non-Mac hosts that should receive the smallest safe recommended model:
 * CPU-only, consumer integrated/UMA graphics, or a discrete card below 8 GiB.
 * High-performance unified accelerators (notably GB10/DGX Spark) stay on the
 * normal large-model path.
 */
export function needsSmallModelRecommendation(device: RecoDevice): boolean {
  if (device.platform === 'darwin') return false;
  const kind =
    device.gpuMemoryKind ?? (device.gpuVramBytes == null ? ('none' as const) : ('unknown' as const));
  if (kind === 'unified') return false;
  if (kind === 'integrated' || kind === 'none') return true;
  return device.gpuVramBytes == null || device.gpuVramBytes < SMALL_MODEL_VRAM_THRESHOLD;
}

interface Scored {
  m: RecoModelInput;
  score: number;
  isMoE: boolean;
  tier: string;
  comfortable: boolean;
}

/** MoE offload is a Mac / small-GPU win; a big discrete GPU prefers dense. */
export function prefersMoE(device: RecoDevice): boolean {
  if (device.platform === 'darwin') return true;
  return device.gpuVramBytes != null && device.gpuVramBytes <= DENSE_ONLY_VRAM_THRESHOLD;
}

/** Big discrete GPU (> 24 GB VRAM, non-Mac) → run dense; drop MoE candidates. */
export function excludesMoE(device: RecoDevice): boolean {
  return (
    device.platform !== 'darwin' &&
    device.gpuVramBytes != null &&
    device.gpuVramBytes > DENSE_ONLY_VRAM_THRESHOLD
  );
}

/**
 * Unified-memory host: Apple Silicon, or a non-Mac where the reported
 * "VRAM" is really the shared pool (GB10 / DGX Spark: nvidia-smi reports
 * no VRAM, so llama-server's device probe returns ~all of system RAM).
 *
 * Known gap this predicate exists to route around: `excludesMoE` above
 * reads `gpuVramBytes > 24 GB, non-Mac` as "big discrete GPU" and so
 * misfires TRUE on unified non-Mac hosts — exactly the bandwidth-bound
 * machines where MoE is the right call. Fixing `excludesMoE` changes
 * the first-run auto-pick and is deferred to a deliberate review (see
 * docs/model-fitness.md); the browse hint uses these predicates instead.
 */
export function isUnifiedMemoryDevice(device: RecoDevice): boolean {
  if (device.platform === 'darwin') return true;
  if (device.gpuMemoryKind === 'integrated' || device.gpuMemoryKind === 'unified') return true;
  return device.gpuVramBytes != null && device.gpuVramBytes >= 0.75 * device.totalRamBytes;
}

/**
 * Memory-bandwidth-bound host — unified memory, or a small discrete GPU
 * that must stream weights from system RAM. On these machines a sparse
 * MoE model (few experts active per token) responds faster than a dense
 * model of the same size.
 */
export function isBandwidthBoundHost(device: RecoDevice): boolean {
  if (isUnifiedMemoryDevice(device)) return true;
  return device.gpuVramBytes != null && device.gpuVramBytes <= DENSE_ONLY_VRAM_THRESHOLD;
}

export interface HardwareHint {
  kind: 'moe-good-match' | 'large-dense-caution' | 'low-acceleration-caution';
  /** Short pill label. */
  label: string;
  /** Longer tooltip explanation. */
  detail: string;
}

/**
 * Browse-time, hint-only guidance for one model on this machine.
 * Advisory copy beside the fit pill — it never filters, ranks, or
 * changes the first-run pick (`prefersMoE`/`excludesMoE` above stay
 * byte-identical for that path).
 */
export function hardwareHint(
  device: RecoDevice,
  model: { isMoE: boolean; fitTier: string; residentBytes?: number },
): HardwareHint | null {
  if (
    needsSmallModelRecommendation(device) &&
    model.fitTier !== 'too-big' &&
    model.residentBytes != null &&
    model.residentBytes > SMALL_MODEL_VRAM_THRESHOLD
  ) {
    return {
      kind: 'low-acceleration-caution',
      label: 'large model — likely very slow here',
      detail:
        'This model may load by using system memory, but this machine has no fast accelerator large enough to run it well. A small model will be substantially more usable.',
    };
  }
  if (!isBandwidthBoundHost(device)) return null;
  const runnable = model.fitTier !== 'too-big';
  if (model.isMoE && runnable) {
    return {
      kind: 'moe-good-match',
      label: 'good match for this machine',
      detail:
        "This machine's memory bandwidth favors Mixture-of-Experts models — only a few experts work per word, so they respond faster than a dense model of the same size.",
    };
  }
  if (
    !model.isMoE &&
    runnable &&
    model.residentBytes != null &&
    model.residentBytes > device.usableBytes / 2
  ) {
    return {
      kind: 'large-dense-caution',
      label: 'dense — may respond slowly here',
      detail:
        'A large dense model reads all of its weights for every word. On this machine, memory bandwidth will pace it — a Mixture-of-Experts model of similar size will feel faster.',
    };
  }
  return null;
}

/** Comfortable-fit ranking: score, then MoE-alignment, then largest that fits. */
function comparator(preferMoE: boolean) {
  const align = (s: Scored) => (s.isMoE === preferMoE ? 1 : 0);
  return (a: Scored, b: Scored): number => {
    if (b.score !== a.score) return b.score - a.score;
    if (align(b) !== align(a)) return align(b) - align(a);
    return b.m.residentBytes - a.m.residentBytes;
  };
}

/**
 * Pick the recommended model to install on `device`, or null when the catalog
 * carries no eligible (scored + open) candidate at all.
 */
export function pickRecommendedModel(
  models: readonly RecoModelInput[],
  device: RecoDevice,
): RecoPick | null {
  const preferMoE = prefersMoE(device);
  const excludeMoE = excludesMoE(device);

  const scored: Scored[] = models.filter(isRecommendedModel).map((m) => {
    const isMoE = isMoEFromTags(m.tags);
    const fit = computeModelFit({
      residentBytes: m.residentBytes,
      isMoE,
      usableBytes: device.usableBytes,
      totalRamBytes: device.totalRamBytes,
      gpuVramBytes: device.gpuVramBytes,
      ...(device.budgetBytes !== undefined ? { admissibleBytes: device.budgetBytes } : {}),
      ...(m.nonExpertBytes !== undefined ? { nonExpertBytes: m.nonExpertBytes } : {}),
    });
    return {
      m,
      score: m.recoScore as number,
      isMoE,
      tier: fit.tier,
      comfortable: fit.tier === 'fits' || fit.tier === 'fits-offload',
    };
  });

  if (scored.length === 0) return null;

  // Loading is not the same thing as being usable. On CPU/iGPU hosts and
  // sub-8-GiB cards, combined RAM+VRAM accounting can make a 20+ GiB MoE pass
  // the admission check while generation is effectively CPU-paced. First run
  // should be useful, so choose the smallest curated candidate outright.
  if (needsSmallModelRecommendation(device)) {
    scored.sort((a, b) =>
      a.m.residentBytes !== b.m.residentBytes
        ? a.m.residentBytes - b.m.residentBytes
        : a.isMoE !== b.isMoE
          ? Number(a.isMoE) - Number(b.isMoE)
          : b.score - a.score,
    );
    const top = scored[0] as Scored;
    return {
      id: top.m.id,
      recoScore: top.score,
      reason: `${top.m.id} (recoScore ${top.score}) — safest small model for CPU, integrated graphics, or a GPU below 8 GiB`,
    };
  }

  const comfortable = scored.filter((s) => s.comfortable && !(excludeMoE && s.isMoE));
  if (comfortable.length > 0) {
    comfortable.sort(comparator(preferMoE));
    const top = comfortable[0] as Scored;
    return {
      id: top.m.id,
      recoScore: top.score,
      reason: `${top.m.id} (recoScore ${top.score}, ${top.isMoE ? 'MoE' : 'dense'}, ${top.tier})`,
    };
  }

  // Best-effort: nothing fits comfortably. Offer the SMALLEST candidate (most
  // likely to at least load), breaking ties toward the higher score. Still
  // honor MoE exclusion, but fall back to the full pool if that empties.
  const notExcluded = scored.filter((s) => !(excludeMoE && s.isMoE));
  const pool = notExcluded.length > 0 ? notExcluded : scored;
  pool.sort((a, b) =>
    a.m.residentBytes !== b.m.residentBytes
      ? a.m.residentBytes - b.m.residentBytes
      : b.score - a.score,
  );
  const top = pool[0] as Scored;
  return {
    id: top.m.id,
    recoScore: top.score,
    reason: `${top.m.id} (recoScore ${top.score}, ${top.isMoE ? 'MoE' : 'dense'}) — best-effort, nothing fits comfortably`,
  };
}

/**
 * Fast-memory budget available to a VIDEO generation, in bytes.
 *
 * Unlike the general {@link RecoDevice.usableBytes} (which reserves ~40% of
 * unified memory as headroom for a *coexisting* chat model), video generation
 * evicts the chat model first (the GPU arbiter's swap policy), so on Apple
 * unified memory it can use most of RAM — reserving only OS/process overhead.
 * Discrete GPUs are still bounded by their VRAM; CPU-only can't run these.
 */
const VIDEO_UNIFIED_MEMORY_FRACTION = 0.8;
export function videoMemoryBudgetBytes(device: RecoDevice): number {
  if (device.gpuVramBytes != null) return device.gpuVramBytes;
  if (device.platform === 'darwin') {
    return Math.floor(device.totalRamBytes * VIDEO_UNIFIED_MEMORY_FRACTION);
  }
  return 0;
}

/**
 * Simple fit check for a MEDIA model (image / video). Image generation leans
 * on system RAM (sd-cpp runs partly on CPU), so it gates on `minRamGB`; video
 * generation needs real GPU VRAM (or Apple unified memory), so it gates on
 * `minVramGB` against the video-specific budget above. A field left undefined
 * isn't checked. Audio models carry neither floor, so callers treat them as
 * always fitting. Deliberately coarser than the chat picker — there's one
 * recommended model per media modality, so this only answers "can this device
 * run it at all?".
 */
export function mediaModelFits(
  device: RecoDevice,
  req: { minRamGB?: number; minVramGB?: number },
): boolean {
  if (req.minRamGB != null && device.totalRamBytes < req.minRamGB * GB) return false;
  if (req.minVramGB != null && videoMemoryBudgetBytes(device) < req.minVramGB * GB) return false;
  return true;
}
