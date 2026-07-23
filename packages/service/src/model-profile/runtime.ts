/**
 * Helpers for the runtime points where local-model providers (Ollama,
 * llama-cpp, mlx) gate features on the resolved profile. The bridge +
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
import { extractReasoning } from '../providers/local-tool-call-salvage.js';
import { lookupBehavior } from './registry.js';
import type { ResolvedBehaviorEntry, ResolvedModelProfile } from './types.js';

const log = createLogger('model-profile');

/**
 * True when the resolved profile opts in to a behavior with the given
 * id. Marker behaviors (`turn.preamble-folding`,
 * `parse.gemma-special-token`) use this; the call site doesn't need
 * the entry's config.
 */
export function profileHasBehavior(
  profile: ResolvedModelProfile | undefined,
  behaviorId: string,
): boolean {
  if (!profile) return false;
  return profile.behaviors.some((entry) => entry.id === behaviorId);
}

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
 * Look up a parameterized behavior's validated config off a profile.
 * Returns `null` when the behavior is absent so the caller can branch
 * on opt-in. The runtime has already applied the behavior's
 * `defaultConfig` and Zod validation by the time this fires, so the
 * shape callers receive is exactly what their consumer expects.
 */
export function profileBehaviorConfig<T>(
  profile: ResolvedModelProfile | undefined,
  behaviorId: string,
): T | null {
  if (!profile) return null;
  const entry = profile.behaviors.find((e) => e.id === behaviorId);
  if (!entry) return null;
  return entry.config as T;
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
/**
 * Universal `extractReasoning` (handles `<think>` / `<|channel|>` /
 * `<reasoning>` blocks) followed by a profile-driven composition of
 * every behavior with `captureReasoning` and `stripVisibleContent`
 * hooks. Each behavior sees the previous behavior's `visible` output,
 * strips its own format, and (for capture-reasoning) contributes any
 * captured prose to the reasoning channel.
 *
 * Order:
 *   1. Universal `extractReasoning` first — strips structured tag
 *      formats before per-behavior passes try to scrape bare-prose
 *      leaks. Avoids `reasoning.capture-pre-tool-prose` mistakenly
 *      grabbing a `thought\n` inside a `<|channel|>` block.
 *   2. Profile `captureReasoning` hooks — extract any remaining
 *      family-specific reasoning shapes (e.g.
 *      `reasoning.capture-pre-tool-prose` for Gemma's bare leaks).
 *   3. Profile `stripVisibleContent` hooks — final visible-content
 *      scrub for behaviors that need to remove markup that doesn't
 *      go to the reasoning channel (no shipped behavior uses this
 *      yet; the consumer exists so a future hook lands cleanly).
 */
export function extractReasoningWithProfile(
  text: string,
  profile: ResolvedModelProfile | undefined,
): { visible: string; reasoning: string } {
  const base = extractReasoning(text);
  if (!profile) return base;
  let visible = base.visible;
  const reasoningParts: string[] = base.reasoning ? [base.reasoning] : [];
  for (const entry of profile.behaviors) {
    const hook = entry.behavior.captureReasoning;
    if (!hook) continue;
    // The hook's `ctx` arg is intentionally not constructed here:
    // every shipped capture-reasoning behavior is format-keyed and
    // doesn't read context. If a future behavior needs ctx, we'll
    // thread it then; today's call sites don't have profile-side
    // model context handy, and synthesizing one here would be
    // forwarding fields the hook ignores.
    const out = hook(visible, undefined as never, entry.config);
    visible = out.visible;
    if (out.reasoning) reasoningParts.push(out.reasoning);
  }
  for (const entry of profile.behaviors) {
    const hook = entry.behavior.stripVisibleContent;
    if (!hook) continue;
    visible = hook(visible, undefined as never, entry.config);
  }
  return {
    visible,
    reasoning: reasoningParts.filter((s) => s.length > 0).join('\n\n'),
  };
}

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
