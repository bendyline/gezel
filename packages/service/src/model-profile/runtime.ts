/**
 * Helpers for the runtime points where local-model providers (Ollama,
 * llama-cpp, mlx, ds4) gate features on the resolved profile. The bridge +
 * chat-manager-side wiring composes hooks naturally; the providers
 * have a different shape — they instantiate stateful machinery
 * (RambleDetector class, foldPreToolPreamble call site, Gemma
 * special-token salvage) that doesn't fit the hook surface. These
 * helpers translate "is behavior X opted in?" + "what's its config?"
 * into the data the providers actually need.
 *
 * Each helper accepts an optional profile and degrades gracefully
 * (returns `false` / `null` / config defaults) when undefined, so
 * legacy code paths that don't yet thread a profile keep working.
 */

import { createLogger } from '@bendyline/gezel';
import { lookupBehavior } from './registry.js';
import type { ResolvedBehaviorEntry, ResolvedModelProfile } from './types.js';

// The profile reads the local loop makes live in core with the loop itself.
export {
  extractReasoningWithProfile,
  profileBehaviorConfig,
  profileHasBehavior,
} from '@bendyline/gezel/local-loop';
import { profileHasBehavior } from '@bendyline/gezel/local-loop';

const log = createLogger('model-profile');

function parseBehaviorIdList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply per-run behavior overrides from the environment to a resolved
 * profile. Feature-agnostic and reusable for any A/B:
 *
 *   - `GEZEL_FORCE_BEHAVIORS` — comma-separated behavior ids to ADD
 *     (e.g. `tools.gezels-as-roles`). Already-present ids are skipped;
 *     unknown ids are logged and ignored; parameterized behaviors get
 *     their validated `defaultConfig`.
 *   - `GEZEL_REMOVE_BEHAVIORS` — comma-separated ids to remove.
 *
 * Returns the same profile reference when no override applies (so the
 * common path is allocation-free), otherwise a shallow copy with a new
 * `behaviors` array. The eval runner injects these env vars per-run via
 * the daemon spawn `extraEnv`, so control vs treatment is one flag — no
 * catalog edits or rebuilds between runs.
 */
export function applyBehaviorEnvOverrides(profile: ResolvedModelProfile): ResolvedModelProfile {
  const add = parseBehaviorIdList(process.env.GEZEL_FORCE_BEHAVIORS);
  const remove = parseBehaviorIdList(process.env.GEZEL_REMOVE_BEHAVIORS);
  if (add.length === 0 && remove.length === 0) return profile;

  let behaviors = profile.behaviors as ResolvedBehaviorEntry[];

  if (remove.length > 0) {
    const removeSet = new Set(remove);
    const before = new Set(behaviors.map((e) => e.id));
    for (const id of remove) {
      if (!before.has(id)) {
        // Loud no-op: an A/B "removal" arm that names a behavior the
        // profile never had is control-vs-control. Same class as the
        // vacuous round below.
        log.warn(
          `[model-profile] GEZEL_REMOVE_BEHAVIORS named "${id}" but the resolved profile for ${profile.catalogId ?? '(unknown)'} does not carry it — no-op.`,
        );
      }
    }
    behaviors = behaviors.filter((e) => !removeSet.has(e.id));
  }

  if (add.length > 0) {
    const present = new Set(behaviors.map((e) => e.id));
    const additions: ResolvedBehaviorEntry[] = [];
    for (const id of add) {
      if (present.has(id)) {
        // Loud no-op: forcing a behavior the manifest already declares
        // silently converges the A/B arms (wild-caught:
        // qwen3.6-27b-q4 declares prompt.tool-cookbook-condensed, so a
        // force-add round ran control-vs-control — identical prompts,
        // 36 trials of noise).
        log.warn(
          `[model-profile] GEZEL_FORCE_BEHAVIORS named "${id}" but the resolved profile for ${profile.catalogId ?? '(unknown)'} already carries it — no-op.`,
        );
        continue;
      }
      const behavior = lookupBehavior(id);
      if (!behavior) {
        log.warn(
          `[model-profile] GEZEL_FORCE_BEHAVIORS named unknown behavior "${id}"; skipping (typo, or not registered in ALL_BEHAVIORS).`,
        );
        continue;
      }
      let config: unknown;
      if (behavior.configSchema) {
        const parsed = behavior.configSchema.safeParse(behavior.defaultConfig);
        if (!parsed.success) {
          log.warn(
            `[model-profile] GEZEL_FORCE_BEHAVIORS could not apply "${id}" — defaultConfig failed validation; skipping.`,
          );
          continue;
        }
        config = parsed.data;
      }
      additions.push({ id, config, behavior });
      present.add(id);
    }
    if (additions.length > 0) behaviors = [...behaviors, ...additions];
  }

  if (behaviors === (profile.behaviors as ResolvedBehaviorEntry[])) return profile;
  return { ...profile, behaviors };
}

/**
 * Walk `numPredict` hooks on the profile and return the first
 * non-null value. Used by Ollama / llama-cpp / mlx in place of the
 * legacy `pickOllamaNumPredict` substring matcher; replicates the
 * "verbose-family models bumped to 16384" behavior via the registered
 * `turn.ollama-num-predict-bumped` behavior's `numPredict` hook.
 *
 * Returns `null` when no behavior fires; the caller falls back to its
 * own default (`DEFAULT_OLLAMA_NUM_PREDICT`) or to a user-configured
 * override.
 */

export function profileNumPredict(
  profile: ResolvedModelProfile | undefined,
  ctxArgs: { modelId: string | undefined; providerName: 'ollama' | 'llama-cpp' | 'mlx' },
): number | null {
  if (!profile) return null;
  for (const entry of profile.behaviors) {
    const hook = entry.behavior.numPredict;
    if (!hook) continue;
    const ctx = {
      catalogId: profile.catalogId,
      tier: profile.tier,
      family: profile.style.family,
      modelId: ctxArgs.modelId,
      providerName: ctxArgs.providerName,
    };
    const value = hook(ctx, entry.config);
    if (typeof value === 'number') return value;
  }
  return null;
}
