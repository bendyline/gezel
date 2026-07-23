/**
 * Model capability tier — the canonical taxonomy that scales prompt
 * verbosity, schema relaxation, tool-allowlist filtering, and (since the
 * role-registry work) per-role capability floors.
 *
 * The *classification* of a concrete model into a tier lives in the
 * service layer (it needs provider + param-size parsing); this module owns
 * only the type and its ordering so that core-level role declarations can
 * reference a `capabilityFloor` without depending on the service. The
 * service's `local-model-tier` re-exports `ModelTier` from here, keeping a
 * single source of truth for the union.
 *
 *   tiny    < 5B            needs the full cookbook + schema relaxation
 *   small   5–11.99B        condensed anti-fabrication rules only
 *   medium  12–44.99B       frontier-style strict surface
 *   large   ≥45B (local)    high-end local
 *   cloud   any cloud       behaviorally ≈ large, kept distinct
 */
export type ModelTier = 'tiny' | 'small' | 'medium' | 'large' | 'cloud';

/**
 * Tiers from least to most capable. Index = rank. Typed as a literal
 * tuple (not a widened `readonly ModelTier[]`) so schemas can derive a
 * Zod enum from it — see `ModelTierSchema` in schemas/craftbook.ts.
 */
export const MODEL_TIER_ORDER = [
  'tiny',
  'small',
  'medium',
  'large',
  'cloud',
] as const satisfies readonly ModelTier[];

/** Ordinal rank of a tier (tiny = 0 … cloud = 4). */
export function tierRank(tier: ModelTier): number {
  return MODEL_TIER_ORDER.indexOf(tier);
}

/** True when `tier` is at least as capable as `floor`. */
export function tierAtLeast(tier: ModelTier, floor: ModelTier): boolean {
  return tierRank(tier) >= tierRank(floor);
}
