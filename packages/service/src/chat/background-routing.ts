/**
 * Cross-engine routing for background (housekeeping) work.
 *
 * The provider queue already separates `interactive` from `background`
 * lanes, so chores (session summaries, memory extraction/consolidation,
 * icon/about drafts) never cut in front of a user's live turn. But when
 * they run on the *same* engine as the foreground chat, they still
 * compete for that one engine's compute — the 30B that's mid-response
 * has to time-slice with the summarizer.
 *
 * On a machine running both engines under a `coexist` GPU policy (big
 * unified-memory Apple Silicon, or a discrete GPU with headroom), a
 * smaller model is often *already resident* on the other engine. Routing
 * the chore there turns "queues behind chat" into genuine parallelism:
 * the big model keeps streaming while a 4B does the housekeeping.
 *
 * This module is the pure decision — given the resident set, the
 * foreground engine, and the GPU policy, which engine+model (if any)
 * should a background task prefer? The caller owns the side effects
 * (looking up the pool snapshot, binding the provider) and only applies
 * the result when the task hasn't pinned a specific model itself.
 */

import type { ProviderName } from '@bendyline/gezel';
import { isLocalProvider } from '@bendyline/gezel';
import type { GpuPolicy } from '../providers/gpu-arbiter.js';
import { type ModelTier, classifyModelTier } from './local-model-tier.js';

export type LocalProviderName = 'llama-cpp' | 'mlx' | 'ds4';

/** A model currently resident in the engine pool. */
export interface ResidentModel {
  provider: LocalProviderName;
  modelId: string;
}

export interface SelectBackgroundEngineArgs {
  /** The engine the foreground task would otherwise run on. */
  foregroundProvider: ProviderName;
  /** Distinct `(provider, modelId)` pairs currently resident in the pool. */
  resident: ResidentModel[];
  /** Live GPU arbitration policy. Cross-engine routing only pays off
   *  under `coexist` — under `swap`, using the other engine would evict
   *  the foreground model, the opposite of what we want. */
  gpuPolicy: GpuPolicy;
}

/** Tiers small enough to be worth offloading chores onto. */
const BACKGROUND_TIERS: ReadonlySet<ModelTier> = new Set<ModelTier>(['tiny', 'small']);

function tierRank(tier: ModelTier): number {
  // Smaller = preferred for cheap background work.
  switch (tier) {
    case 'tiny':
      return 0;
    case 'small':
      return 1;
    case 'medium':
      return 2;
    case 'large':
      return 3;
    default:
      return 4; // cloud — never a local background target
  }
}

/**
 * Pick the best already-resident engine+model to run a background task
 * on, or `null` to leave it on the foreground engine.
 *
 * Rules:
 *   - Only under a `coexist` GPU policy, and only when the foreground
 *     is itself a local engine (cross-engine parallelism is a
 *     local↔local story; cloud foregrounds already run off-box).
 *   - Candidates must be resident (never spawn a model just for a
 *     chore) and classify as `tiny`/`small` (a chore on a 30B isn't a
 *     chore).
 *   - Prefer a model on a *different* engine than the foreground — that
 *     is the case that actually parallelizes. A small model resident on
 *     the *same* engine would still queue on that engine, so it's not a
 *     routing win and we decline (return null), leaving the existing
 *     same-engine background-lane behavior untouched.
 *   - Among different-engine candidates, prefer the smallest tier, then
 *     a stable modelId sort for determinism.
 */
export function selectBackgroundEngine(args: SelectBackgroundEngineArgs): ResidentModel | null {
  if (args.gpuPolicy !== 'coexist') return null;
  if (!isLocalProvider(args.foregroundProvider)) return null;

  const candidates = args.resident
    .filter((m) => m.provider !== args.foregroundProvider)
    .filter((m) =>
      BACKGROUND_TIERS.has(classifyModelTier({ providerName: m.provider, modelId: m.modelId })),
    )
    .sort((a, b) => {
      const ra = tierRank(classifyModelTier({ providerName: a.provider, modelId: a.modelId }));
      const rb = tierRank(classifyModelTier({ providerName: b.provider, modelId: b.modelId }));
      if (ra !== rb) return ra - rb;
      return a.modelId.localeCompare(b.modelId);
    });

  return candidates[0] ?? null;
}
