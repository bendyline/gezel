import type { ChatModelManifest, RecoModelInput } from '@bendyline/gezel';
import { pickRecommendedModel } from '@bendyline/gezel';
import { detectMemoryProfile } from '../../system/memory.js';

/**
 * Pick the on-device model to install on first run.
 *
 * The choice is data-driven: every catalog chat-model that passes core's
 * `isRecommendedModel` gate (curated `recoScore`, fully-open license, tool
 * support) is a candidate, and the best one for THIS machine is chosen by
 * `pickRecommendedModel` (core) —
 * highest score, MoE-vs-VRAM alignment, then the largest that comfortably
 * fits. See `packages/core/src/recommendation.ts` for the ranking rules; this
 * module just supplies the two live inputs:
 *
 *   1. the machine's memory profile (`detectMemoryProfile` — RAM + GPU memory
 *      via nvidia-smi / the bundled `llama-server --list-devices`, including
 *      integrated-vs-discrete classification so shared RAM is not counted twice),
 *   2. the catalog candidates, each mapped to the working set of the on-device
 *      provider for this platform (MLX on Mac, llama.cpp elsewhere).
 *
 * We never crash on a detection miss: an empty candidate set falls back to a
 * safe small default, and the user can always switch post-install in Settings.
 */

/** on-disk size → working set (KV cache, activations). Matches the UI's fit calc. */
const MEMORY_OVERHEAD_FACTOR = 1.2;

/** Safe universal default if the catalog somehow ships no recommended model. */
const FALLBACK_TIER = 'gemma4-e2b-q4';

/** A catalog chat-model id (the pinned first-run model). */
export type ModelTier = string;

export interface TierDecision {
  /** The chosen catalog chat-model id. */
  tier: string;
  /** One-sentence human-readable rationale for the decision. */
  reason: string;
  /** All inputs the decision was made from — logged + shown to the user. */
  inputs: {
    platform: string;
    totalRamBytes: number;
    gpuVramBytes?: number;
    gpuMemoryKind?: 'discrete' | 'integrated' | 'unified' | 'none' | 'unknown';
    usableBytes: number;
  };
}

/**
 * Map a catalog chat-model manifest to a recommendation candidate for the
 * given platform's on-device provider (MLX on Mac, llama.cpp elsewhere).
 * Returns null when the model ships no block for that provider (can't install
 * it there). `residentBytes` prefers the manifest's pinned value, else the
 * on-disk size × overhead — the same working-set estimate the UI's fit badge
 * uses. Pure — unit-tested.
 */
export function toRecoCandidate(m: ChatModelManifest, platform: string): RecoModelInput | null {
  const block = platform === 'darwin' ? m.mlx : m.llamaCpp;
  if (!block) return null;
  const approx = block.approxSizeBytes ?? m.approxSizeBytes;
  const residentBytes = block.residentBytes ?? Math.round(approx * MEMORY_OVERHEAD_FACTOR);
  return {
    id: m.id,
    ...(m.recoScore != null ? { recoScore: m.recoScore } : {}),
    ...(m.licenseClass != null ? { licenseClass: m.licenseClass } : {}),
    supportsTools: m.supportsTools,
    tags: m.tags,
    residentBytes,
  };
}

/**
 * Choose the first-run on-device model. `models` are the catalog's chat-model
 * manifests (the caller lists them from the CatalogService). Probes live host
 * memory + GPU and returns the picked catalog id with a rationale.
 */
export async function detectModelTier(models: readonly ChatModelManifest[]): Promise<TierDecision> {
  const mem = await detectMemoryProfile();
  const inputs: TierDecision['inputs'] = {
    platform: mem.platform,
    totalRamBytes: mem.totalRamBytes,
    ...(mem.gpuVramBytes != null ? { gpuVramBytes: mem.gpuVramBytes } : {}),
    gpuMemoryKind: mem.gpuMemoryKind,
    usableBytes: mem.usableBytes,
  };

  const candidates = models
    .map((m) => toRecoCandidate(m, mem.platform))
    .filter((c): c is RecoModelInput => c !== null);

  const pick = pickRecommendedModel(candidates, {
    platform: mem.platform,
    gpuVramBytes: mem.gpuVramBytes,
    gpuMemoryKind: mem.gpuMemoryKind,
    totalRamBytes: mem.totalRamBytes,
    usableBytes: mem.usableBytes,
    // The broker's ceiling, so first run never installs a model the very
    // next chat turn refuses to load.
    budgetBytes: mem.budgetBytes,
  });

  if (!pick) {
    return {
      tier: FALLBACK_TIER,
      reason: `no recommended candidate matched — falling back to ${FALLBACK_TIER}`,
      inputs,
    };
  }
  return { tier: pick.id, reason: pick.reason, inputs };
}
