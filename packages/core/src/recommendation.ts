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
 *      discounted for a 1- or 2-bit quant ({@link lowBitScoreFactor}),
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
import {
  MOE_NON_EXPERT_FRACTION_ESTIMATE,
  type ModelFitResult,
  computeModelFit,
  isMoEFromTags,
} from './model-fit.js';
import { lowBitScoreFactor } from './model-quantization.js';

const GB = 1024 ** 3;

/** Catalog lifecycle tag used for models kept only for compatibility. */
export const RETIRED_MODEL_TAG = 'retired';

export const RETIRED_MODEL_TOOLTIP =
  'This model is kept for compatibility but is no longer recommended for new downloads.';

/** Tags are authored content, so match defensively across casing and whitespace. */
export function isRetiredModel(manifest: { tags?: readonly string[] }): boolean {
  return manifest.tags?.some((tag) => tag.trim().toLowerCase() === RETIRED_MODEL_TAG) ?? false;
}

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
  /** Retired entries remain installable deliberately, never recommended automatically. */
  tags?: readonly string[];
}

/**
 * The single "would we recommend this model?" gate. The first-run picker
 * below, the ★ Recommended badge, the CLI bootstrap and the media pickers all
 * call this so they can never drift apart.
 *
 * Four conditions:
 *   1. a hand-curated positive `recoScore` — absent means no one nominated it;
 *   2. a fully-open license, so a stray score on a restricted model is ignored;
 *   3. tool support. Gezels do their work THROUGH the MCP toolset, so a model
 *      that cannot call tools is never a sane default no matter how good its
 *      prose is — it stays installable, but choosing it has to be the user's
 *      deliberate act, not ours.
 *   4. no `retired` lifecycle tag. Retired builds stay available behind the
 *      catalog's Show all control, but must never become an automatic choice.
 *
 * Media manifests carry no `supportsTools` field, hence `!== false` rather
 * than `=== true`: undefined passes, only an explicit refusal disqualifies.
 */
export function isRecommendedModel(m: RecoGateInput): boolean {
  return (
    typeof m.recoScore === 'number' &&
    m.recoScore > 0 &&
    m.licenseClass === 'open' &&
    m.supportsTools !== false &&
    !isRetiredModel(m)
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
  /** The engine block's quantization tag (`UD-Q4_K_XL`, `4bit`); a 1- or 2-bit quant ranks lower. */
  quantization?: string;
  /**
   * What starting the model needs: its working set plus the KV cache at this
   * host's context floor, with the engine's compute headroom. Compared with
   * {@link RecoDevice.launchCapBytes}. Absent = `residentBytes`.
   */
  launchBytes?: number;
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
  /**
   * The most a launch could hold right now: the free part of the fast pool
   * plus the system RAM free now, less the OS reserve, capped by the budget. The launch-time
   * context check applies this same ceiling. `budgetBytes` is fixed by the
   * machine's size, so on a 12 GB card and 31 GB of RAM it admitted a 23.5 GB
   * model the first chat turn refused with 7.7 GB of RAM free.
   */
  launchCapBytes?: number;
  /**
   * A discrete card's free memory right now, as device admission counts it.
   * A MoE larger than the card needs room there for its always-active
   * layers; any other model larger than the card is charged the whole card.
   * Leave unset on unified and integrated hosts.
   */
  freeGpuBytes?: number;
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
    device.gpuMemoryKind ??
    (device.gpuVramBytes == null ? ('none' as const) : ('unknown' as const));
  if (kind === 'unified') return false;
  if (kind === 'integrated' || kind === 'none') return true;
  return device.gpuVramBytes == null || device.gpuVramBytes < SMALL_MODEL_VRAM_THRESHOLD;
}

interface Scored {
  m: RecoModelInput;
  score: number;
  isMoE: boolean;
  tier: string;
  /** Whether a launch would be admitted with the memory free now. */
  launchable: boolean;
  comfortable: boolean;
}

/**
 * Whether the launch check would admit this model now. A model the machine
 * could hold in principle is no first pick if the person's first chat turn
 * is refused with "not enough memory", and the failure card reads the same
 * verdict to decide whether Retry can help.
 */
export function launchFitsNow(
  m: Pick<RecoModelInput, 'residentBytes' | 'launchBytes' | 'tags' | 'nonExpertBytes'>,
  device: Pick<RecoDevice, 'launchCapBytes' | 'freeGpuBytes' | 'usableBytes'>,
): boolean {
  if (
    device.launchCapBytes !== undefined &&
    (m.launchBytes ?? m.residentBytes) > device.launchCapBytes
  ) {
    return false;
  }
  if (device.freeGpuBytes === undefined || m.residentBytes <= device.usableBytes) return true;
  // Larger than the card. A MoE's offload plan keeps only its always-active
  // layers there and streams the experts; any other model is charged the
  // whole card.
  const onCard = isMoEFromTags(m.tags)
    ? (m.nonExpertBytes ?? m.residentBytes * MOE_NON_EXPERT_FRACTION_ESTIMATE) +
      OFFLOAD_CARD_RESERVE_BYTES
    : device.usableBytes;
  return device.freeGpuBytes >= onCard;
}

/**
 * What an offload plan keeps on the card beside the always-active layers:
 * the KV cache at a working window, the compute buffers and a margin.
 */
const OFFLOAD_CARD_RESERVE_BYTES = 2 * GB;

/** "recoScore 21", or "recoScore 21 → 16.8 (2-bit)" when the quant discount applied. */
function scoreLabel(s: Scored): string {
  const curated = s.m.recoScore as number;
  if (s.score === curated) return `recoScore ${curated}`;
  return `recoScore ${curated} → ${Math.round(s.score * 10) / 10} (${s.m.quantization})`;
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
  kind: 'moe-good-match' | 'large-dense-caution' | 'low-acceleration-caution' | 'wont-start-now';
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
  model: {
    isMoE: boolean;
    fitTier: string;
    residentBytes?: number;
    /**
     * The daemon's verdict on starting it with the memory free now
     * (`/api/system/memory/starts-now`). Settings called a model that had
     * just been refused a "good match for this machine" (2026-10-11).
     */
    startsNow?: boolean;
  },
): HardwareHint | null {
  if (model.startsNow === false && model.fitTier !== 'too-big') {
    return {
      kind: 'wont-start-now',
      label: "won't start right now",
      detail:
        'Starting it needs more memory than is free at the moment. Close some programs and it may start, or choose a model that fits on its own.',
    };
  }
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
  // A dense model that fits a discrete card runs from its fast memory; the
  // caution is about one paced by system RAM. Gemma 4 12B, which finished a
  // trip plan in three minutes on a 12 GB card, read "may respond slowly".
  const onTheCard =
    model.fitTier === 'fits' && device.gpuVramBytes != null && !isUnifiedMemoryDevice(device);
  if (
    !model.isMoE &&
    runnable &&
    !onTheCard &&
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
    const launchable = launchFitsNow(m, device);
    return {
      m,
      score: (m.recoScore as number) * lowBitScoreFactor(m.quantization),
      isMoE,
      tier: fit.tier,
      launchable,
      comfortable: launchable && (fit.tier === 'fits' || fit.tier === 'fits-offload'),
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
      reason: `${top.m.id} (${scoreLabel(top)}) — safest small model for CPU, integrated graphics, or a GPU below 8 GB`,
    };
  }

  const comfortable = scored.filter((s) => s.comfortable && !(excludeMoE && s.isMoE));
  if (comfortable.length > 0) {
    comfortable.sort(comparator(preferMoE));
    const top = comfortable[0] as Scored;
    const passedOver = scored
      .filter((s) => !s.launchable && s.score > top.score && !(excludeMoE && s.isMoE))
      .map((s) => s.m.id);
    const why =
      passedOver.length > 0
        ? `; passed over ${passedOver.join(', ')}: would not start with the memory free now`
        : '';
    return {
      id: top.m.id,
      recoScore: top.score,
      reason: `${top.m.id} (${scoreLabel(top)}, ${top.isMoE ? 'MoE' : 'dense'}, ${top.tier})${why}`,
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
    reason: `${top.m.id} (${scoreLabel(top)}, ${top.isMoE ? 'MoE' : 'dense'}) — best-effort, nothing fits comfortably`,
  };
}

export interface ModelRating {
  id: string;
  /** The same fit verdict the install browser badges this model with. */
  fit: ModelFitResult;
  /**
   * 0–100: how well this model suits this machine. 100 is the recommended
   * pick; every other model stays below it; 0 means it cannot run here.
   */
  score: number;
  /** The one model {@link pickRecommendedModel} would install here. */
  recommended: boolean;
}

/**
 * What a runnable model that this machine will pace badly keeps of its score:
 * a `tight` fit, or a large model on a host with no fast accelerator. Low
 * enough that any model running comfortably outranks it.
 */
const LIKELY_SLOW_SCORE_FACTOR = 0.4;

/** A MoE on a big discrete GPU runs, but the first-run pick skips it for dense. */
const DENSE_PREFERRED_SCORE_FACTOR = 0.9;

/**
 * Rate every model for this machine, in the order a picker should offer them.
 *
 * The score has two halves. Fit decides whether and how well the model runs
 * here (too big → 0; tight or CPU-paced → heavily discounted). The curated
 * `recoScore`, discounted for very low-bit quants, decides how good it is once
 * it runs: the best curated model that runs here keeps its whole score, an
 * unscored model that runs keeps half. The recommended pick is
 * {@link pickRecommendedModel}'s choice, never re-derived, so this list and
 * first run can never disagree about which model comes first.
 */
export function rateModelsForDevice(
  models: readonly RecoModelInput[],
  device: RecoDevice,
): ModelRating[] {
  const smallModelHost = needsSmallModelRecommendation(device);
  const excludeMoE = excludesMoE(device);
  const preferMoE = prefersMoE(device);
  const rated = models.map((m) => {
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
    const quality = isRecommendedModel(m)
      ? (m.recoScore as number) * lowBitScoreFactor(m.quantization)
      : 0;
    const fitFactor = !fit.runnable
      ? 0
      : fit.tier === 'tight' || (smallModelHost && m.residentBytes > SMALL_MODEL_VRAM_THRESHOLD)
        ? LIKELY_SLOW_SCORE_FACTOR
        : excludeMoE && isMoE
          ? DENSE_PREFERRED_SCORE_FACTOR
          : 1;
    return { m, isMoE, fit, quality, fitFactor };
  });

  const bestQuality = Math.max(0, ...rated.filter((r) => r.fit.runnable).map((r) => r.quality));
  const pick = pickRecommendedModel(models, device);
  const pickId = rated.find((r) => r.m.id === pick?.id)?.fit.runnable ? pick?.id : undefined;

  const ratings = rated.map((r) => {
    const share = bestQuality > 0 ? r.quality / bestQuality : 0;
    const score = Math.round(100 * r.fitFactor * (0.5 + 0.5 * share));
    const recommended = r.m.id === pickId;
    return {
      r,
      rating: {
        id: r.m.id,
        fit: r.fit,
        score: recommended ? 100 : Math.min(99, score),
        recommended,
      },
    };
  });

  // Ties follow the first-run picker: smallest first where only a small model
  // is usable, otherwise MoE-alignment and then the largest that still fits.
  const align = (r: (typeof rated)[number]) => (r.isMoE === preferMoE ? 1 : 0);
  ratings.sort(
    (a, b) =>
      Number(b.rating.recommended) - Number(a.rating.recommended) ||
      b.rating.score - a.rating.score ||
      (smallModelHost
        ? a.r.m.residentBytes - b.r.m.residentBytes
        : align(b.r) - align(a.r) || b.r.m.residentBytes - a.r.m.residentBytes) ||
      a.r.m.id.localeCompare(b.r.m.id),
  );
  return ratings.map(({ rating }) => rating);
}

/**
 * Fast-memory budget available to a VIDEO generation, in bytes.
 *
 * @deprecated Disagrees with the daemon's own admission check. Read the
 * daemon's verdict instead (`GET /api/video-gen/models/fit`), which prices the
 * model with `videoMemoryRequirement` against the capacity the launch path
 * actually admits. Kept only for semver; nothing in this repo calls it.
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
 * Fit check for a MEDIA model against the catalog's hand-authored
 * `minRamGB` / `minVramGB`.
 *
 * @deprecated Those catalog figures are no longer authoritative and are being
 * removed from the catalog. Read the daemon's verdict instead
 * (`GET /api/image-gen/models/fit`, `GET /api/video-gen/models/fit`), which
 * prices the model from its weight files with `media-memory.ts`. Kept only
 * for semver; nothing in this repo calls it.
 */
export function mediaModelFits(
  device: RecoDevice,
  req: { minRamGB?: number; minVramGB?: number },
): boolean {
  if (req.minRamGB != null && device.totalRamBytes < req.minRamGB * GB) return false;
  if (req.minVramGB != null && videoMemoryBudgetBytes(device) < req.minVramGB * GB) return false;
  return true;
}
