/**
 * Growth cosmetic unlock catalog — the single source of truth shared by
 * the service (validating cosmetic proposals) and the UI (labels +
 * accessory-dialog gating). Entries reference REAL poppetje slots only;
 * the level badge is an HTML chip rendered automatically at level ≥2,
 * not an unlock.
 *
 * Gating is UI-enforced and only blocks NEWLY selecting a locked option —
 * a gezel already wearing one keeps it (grandfathering).
 */

export interface GrowthCosmetic {
  /** Stable id stored in growth.json's unlockedCosmetics. */
  id: string;
  slot: 'hat' | 'dress' | 'accessory';
  /** The poppetje option value this unlocks. */
  option: string;
  label: string;
  /** Level at which this becomes selectable. */
  level: number;
}

export const GROWTH_COSMETICS: readonly GrowthCosmetic[] = [
  { id: 'hat.straw', slot: 'hat', option: 'straw', label: 'Straw hat', level: 2 },
  { id: 'hat.newsboy', slot: 'hat', option: 'newsboy', label: 'Newsboy cap', level: 3 },
  { id: 'accessory.monocle', slot: 'accessory', option: 'monocle', label: 'Monocle', level: 4 },
  { id: 'dress.apron', slot: 'dress', option: 'apron', label: 'Workshop apron', level: 5 },
  { id: 'accessory.brooch', slot: 'accessory', option: 'brooch', label: 'Brooch', level: 6 },
  { id: 'hat.hood', slot: 'hat', option: 'hood', label: 'Hood', level: 7 },
  { id: 'accessory.eyepatch', slot: 'accessory', option: 'eyepatch', label: 'Eyepatch', level: 8 },
] as const;

export function growthCosmeticById(id: string): GrowthCosmetic | undefined {
  return GROWTH_COSMETICS.find((c) => c.id === id);
}

/** The next cosmetic at or below `level` that isn't in `unlockedIds`, if any. */
export function nextLockedCosmetic(
  level: number,
  unlockedIds: ReadonlySet<string>,
): GrowthCosmetic | undefined {
  return GROWTH_COSMETICS.find((c) => c.level <= level && !unlockedIds.has(c.id));
}
