/**
 * Canonical tuning profile registry.
 *
 * A **tuning profile** is a named sampling/reasoning preset a model can
 * implement (e.g. `thinking-coding` = lower temperature, thinking enabled).
 * Gezel templates and individual gezels select a profile by id; the resolver
 * looks up the profile in the model's `tuning.profiles` block and applies
 * its sparse `ChatModelTuningBase` partial as a layer in the merge stack:
 *
 *   gezel.tuning override  >  installDefault  >  profile  >  catalog.tuning base
 *
 * If a model doesn't define the requested profile, the resolver walks the
 * profile's fallback chain (e.g. `thinking-coding → thinking-general → instruct`)
 * until it finds one the model actually implements, or falls through to the
 * model's base tuning. Unknown ids that don't match any canonical entry are
 * silently ignored (no throw — the wire format is forward-compatible).
 *
 * Disambiguation: this is distinct from `service/src/model-profile/`, which
 * handles per-model BEHAVIOR bundles (fabrication detection, reasoning-tag
 * stripping). The "tuning" prefix is intentional throughout this file.
 */

import { z } from 'zod';

/**
 * Wire shape for a tuning profile id. Open `z.string()` (not a closed enum)
 * so a manifest can ship a profile id that older clients don't recognize
 * without breaking validation — those clients walk the fallback chain or
 * fall through to base tuning, with a one-line warn log.
 */
export const TuningProfileIdSchema = z.string().min(1).describe('Canonical tuning profile id.');
export type TuningProfileId = z.infer<typeof TuningProfileIdSchema>;

/**
 * The closed set of profile ids the codebase recognizes today. Used for
 * autocomplete, the UI picker, and the fallback-chain table. New
 * canonical ids ship in this list when added.
 */
export const KNOWN_PROFILE_IDS = [
  'thinking-general',
  'thinking-deep',
  'thinking-coding',
  'thinking-precise',
  'instruct',
  'creative',
  'terse',
  'deterministic',
] as const;
export type KnownProfileId = (typeof KNOWN_PROFILE_IDS)[number];

/**
 * Default install-wide tuning profile applied when neither the gezel
 * (`tuningProfile`) nor the install config (`modelTuningProfile[modelId]`)
 * names one. Resolved through the same canonical fallback chain as any
 * explicit pick, so models that don't declare `thinking-general` fall
 * back to `instruct` and then to their base tuning — i.e. a model that
 * can reason does so by default, and one that can't is unaffected.
 */
export const DEFAULT_TUNING_PROFILE_ID: KnownProfileId = 'thinking-general';

/**
 * Whether a profile drives a thinking turn (`reasoning.enableThinking: true`)
 * or an instruct turn. The resolver uses this to suppress the legacy
 * `samplingWhenThinking` fold — if the active profile is `kind: 'thinking'`,
 * the profile's sampling is already correct for thinking mode and folding
 * `samplingWhenThinking` on top would double-apply.
 */
export type ProfileKind = 'thinking' | 'instruct';

export interface ProfileMeta {
  id: KnownProfileId;
  label: string;
  description: string;
  kind: ProfileKind;
  /**
   * Ordered fallback ids the resolver walks when the requested id isn't
   * defined by the model. Excludes `id` itself; the resolver tries the
   * requested id first, then each fallback in order, then falls through
   * to base tuning.
   */
  fallbackChain: KnownProfileId[];
}

export const CANONICAL_PROFILES: Record<KnownProfileId, ProfileMeta> = {
  'thinking-general': {
    id: 'thinking-general',
    label: 'Thinking — General',
    description: 'Reasoning mode for general analytical tasks.',
    kind: 'thinking',
    fallbackChain: ['instruct'],
  },
  'thinking-deep': {
    id: 'thinking-deep',
    label: 'Thinking — Deep',
    description: 'Higher-effort reasoning for difficult tasks when extra latency is acceptable.',
    kind: 'thinking',
    fallbackChain: ['thinking-general', 'instruct'],
  },
  'thinking-coding': {
    id: 'thinking-coding',
    label: 'Thinking — Coding',
    description: 'Reasoning mode tuned for precise coding tasks.',
    kind: 'thinking',
    fallbackChain: ['thinking-general', 'instruct'],
  },
  'thinking-precise': {
    id: 'thinking-precise',
    label: 'Thinking — Precise',
    description: 'Low-temperature reasoning for structured output and fact-checking.',
    kind: 'thinking',
    fallbackChain: ['thinking-coding', 'thinking-general', 'instruct'],
  },
  instruct: {
    id: 'instruct',
    label: 'Instruct',
    description: 'Non-thinking instruct mode for direct answers.',
    kind: 'instruct',
    fallbackChain: [],
  },
  creative: {
    id: 'creative',
    label: 'Creative',
    description: 'Higher-temperature mode for creative writing.',
    kind: 'instruct',
    fallbackChain: ['instruct'],
  },
  terse: {
    id: 'terse',
    label: 'Terse',
    description: 'Short replies; low temperature, limited tokens.',
    kind: 'instruct',
    fallbackChain: ['instruct'],
  },
  deterministic: {
    id: 'deterministic',
    label: 'Deterministic',
    description: 'Temperature 0 for reproducible output (debugging, evals).',
    kind: 'instruct',
    fallbackChain: ['instruct'],
  },
};

export function isKnownProfileId(id: string): id is KnownProfileId {
  return id in CANONICAL_PROFILES;
}

/**
 * Returns the profile kind (`thinking` or `instruct`) for a known id, or
 * undefined for unknown ids. Used by the resolver to gate the
 * `samplingWhenThinking` double-fold.
 */
export function profileKind(id: string | undefined): ProfileKind | undefined {
  if (!id) return undefined;
  return isKnownProfileId(id) ? CANONICAL_PROFILES[id].kind : undefined;
}

/**
 * Walk the canonical fallback chain for `requested` against the set of
 * profile ids `available` (the keys of the model's `tuning.profiles`).
 * Returns the first id in (requested, ...fallbackChain) that's actually
 * present in `available`, or `undefined` if nothing matches.
 *
 * Unknown `requested` ids that aren't in the canonical registry return
 * undefined (the resolver then falls through to base tuning).
 */
export function resolveProfileChain(
  requested: string | undefined,
  available: ReadonlySet<string> | readonly string[],
): KnownProfileId | undefined {
  if (!requested) return undefined;
  const set = available instanceof Set ? available : new Set(available);
  if (!isKnownProfileId(requested)) return undefined;
  if (set.has(requested)) return requested;
  for (const next of CANONICAL_PROFILES[requested].fallbackChain) {
    if (set.has(next)) return next;
  }
  return undefined;
}
