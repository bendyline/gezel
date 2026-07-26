import type { FileMapResponse, MapBlock } from '@bendyline/gezel';

/**
 * Client view of the server's urbanity field. Two accessors, and the rule that
 * keeps them apart:
 *
 * - **`bandOf` switches.** Categorical choices — archetype family table,
 *   wall/roof material, hedge vs picket vs curb, dirt lane vs cobble vs
 *   macadam — read the band. It comes straight from the server's `settlement`
 *   bucket; the renderer never re-derives thresholds from the float, because
 *   the moment it does they drift from the service the first time the policy
 *   is tuned.
 * - **`urbanityOf` lerps.** Continuous choices — prop density, vegetation
 *   coverage, wall hue mix, bay rhythm, parapet height — read the float and
 *   must never compare it against a constant. Bucketing everything would
 *   produce four visible concentric rings, which is the opposite of the
 *   amorphous gradient the field exists to draw.
 */

/** The renderer's three architectural registers. The server's four-bucket
 *  `settlement` collapses `hamlet` into `village`: a hamlet is a sparser
 *  village, not a different vocabulary. */
export type UrbanityBand = 'village' | 'town' | 'city';

/**
 * What a payload without an urbanity field renders as. Deliberately mid-range
 * and deliberately in the `town` band, so every map built before the field
 * existed — and every fixture in the test suite — draws exactly as it did.
 */
export const LEGACY_URBANITY = 0.5;

export function urbanityOf(block: Pick<MapBlock, 'urbanity'>): number {
  return block.urbanity ?? LEGACY_URBANITY;
}

export function bandOf(block: Pick<MapBlock, 'settlement'>): UrbanityBand {
  switch (block.settlement) {
    case 'hamlet':
    case 'village':
      return 'village';
    case 'city':
      return 'city';
    default:
      return 'town';
  }
}

/** Linear interpolation keyed on urbanity, clamped. The idiomatic way to
 *  consume the float — no thresholds at the call site. */
export function byUrbanity(
  block: Pick<MapBlock, 'urbanity'>,
  rural: number,
  urban: number,
): number {
  const t = Math.max(0, Math.min(1, urbanityOf(block)));
  return rural + (urban - rural) * t;
}

const districtCache = new WeakMap<FileMapResponse, Map<string, UrbanityBand>>();

/**
 * Mean band of each district's blocks, memoized per payload. Streets belong to
 * folders rather than files, so their surface — dirt track, cobble, macadam —
 * has to come from the neighborhood around them rather than from any one
 * building. Computed once, not per frame: this runs inside the ground pass.
 */
export function districtBands(model: FileMapResponse): Map<string, UrbanityBand> {
  const hit = districtCache.get(model);
  if (hit) return hit;
  const sum = new Map<string, { total: number; count: number }>();
  for (const b of model.blocks) {
    if (b.state === 'tombstoned' || b.phantom) continue;
    const acc = sum.get(b.districtId) ?? { total: 0, count: 0 };
    acc.total += urbanityOf(b);
    acc.count += 1;
    sum.set(b.districtId, acc);
  }
  const out = new Map<string, UrbanityBand>();
  for (const [id, { total, count }] of sum) {
    const mean = total / Math.max(1, count);
    // Mirrors the service thresholds. The only place the client buckets a
    // float, and only because a district has no `settlement` of its own.
    out.set(id, mean >= 0.74 ? 'city' : mean >= 0.52 ? 'town' : 'village');
  }
  districtCache.set(model, out);
  return out;
}
