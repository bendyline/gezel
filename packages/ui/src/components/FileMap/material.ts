import { seeded } from './seed.js';
import type { UrbanityBand } from './urbanity.js';

/**
 * Building materials for the Village.
 *
 * ## The load-bearing decision: language hue stays on the roof
 *
 * At 2:1 dimetric the top diamond dominates a building's projected area, and at
 * district and city zoom the roof is essentially all you see —
 * `palette.ts` already commits to "block roofs are lang-hued". Moving hue onto
 * the walls in the dense core would therefore kill the language field exactly
 * where the map carries the most information. So:
 *
 * - **Roof** keeps the language hue; the material only shifts lightness and
 *   saturation and pulls the hue a fraction of the way toward its own.
 * - **Wall** mixes the language hue toward the material's hue, and how far is
 *   driven by *continuous* urbanity.
 *
 * Which reads, on the map, as: a village cottage is close to one warm limewashed
 * color, walls and roof agreeing. A city terrace is a slate-and-brick mass under
 * a language-hued roof. Period-correct and information-preserving at once.
 *
 * ## Why the roof/facade lightness delta survives
 *
 * `palette.test.ts` requires roof lightness to exceed facade lightness — that
 * delta is the whole 3D reading. A building's roof and walls are made of
 * *different* materials, so their `litDelta`s differ, and a light wall under a
 * dark roof (stucco under brick) would otherwise close the gap to nothing.
 *
 * So the wall's lightness shift is expressed *relative to the roof's* and
 * clamped to `WALL_LIT_SWING`. Slate-over-stucco still reads lighter-walled
 * than slate-over-brick; it just can't climb into its own roof. The property is
 * enforced by construction rather than by tuning nine materials until the
 * numbers happen to work — see `wallLitDelta`.
 */

export type MaterialKey =
  | 'brick'
  | 'stucco'
  | 'timber'
  | 'stone'
  | 'slate'
  | 'tile'
  | 'thatch'
  | 'glass'
  | 'iron';

export const MATERIAL_KEYS: readonly MaterialKey[] = [
  'brick',
  'stucco',
  'timber',
  'stone',
  'slate',
  'tile',
  'thatch',
  'glass',
  'iron',
];

interface MaterialTone {
  /** Multiplier on saturation — stone and slate desaturate, tile warms up. */
  satMul: number;
  /** Lightness shift, applied EQUALLY to roof and facade. */
  litDelta: number;
  /** The material's own hue, mixed toward per `hueMix`. */
  hue: number;
  /** How far a surface pulls toward `hue` (0 = keep the language hue). */
  hueMix: number;
}

const MATERIAL: Record<MaterialKey, MaterialTone> = {
  brick: { satMul: 1.05, litDelta: -4, hue: 14, hueMix: 0.55 },
  stucco: { satMul: 0.62, litDelta: 6, hue: 42, hueMix: 0.45 },
  timber: { satMul: 0.85, litDelta: -2, hue: 28, hueMix: 0.6 },
  stone: { satMul: 0.4, litDelta: 2, hue: 40, hueMix: 0.5 },
  slate: { satMul: 0.45, litDelta: -8, hue: 220, hueMix: 0.4 },
  tile: { satMul: 1.1, litDelta: -1, hue: 18, hueMix: 0.5 },
  thatch: { satMul: 0.8, litDelta: 4, hue: 44, hueMix: 0.7 },
  glass: { satMul: 0.55, litDelta: 10, hue: 196, hueMix: 0.5 },
  iron: { satMul: 0.35, litDelta: -10, hue: 210, hueMix: 0.55 },
};

/** Wall / roof material candidates per register. Village walls are limewash and
 *  timber under thatch and tile; city walls are brick and stone under slate. */
const WALL_BY_BAND: Record<UrbanityBand, readonly MaterialKey[]> = {
  village: ['timber', 'stucco', 'stone'],
  town: ['brick', 'stucco'],
  city: ['brick', 'stone'],
};
const ROOF_BY_BAND: Record<UrbanityBand, readonly MaterialKey[]> = {
  village: ['thatch', 'tile'],
  town: ['tile', 'slate'],
  city: ['slate', 'tile'],
};

export interface MaterialPair {
  wall: MaterialKey;
  roof: MaterialKey;
}

/**
 * Pick a building's materials. Uses its own salted sub-stream, so adding or
 * retuning materials can never perturb archetype, massing, or facade detail —
 * see the seed rules in `iso/town-style.ts`.
 */
export function materialsFor(seed: number, band: UrbanityBand, industrial: boolean): MaterialPair {
  const random = seeded(seed);
  const walls = WALL_BY_BAND[band];
  const roofs = ROOF_BY_BAND[band];
  const wall = walls[Math.min(walls.length - 1, Math.floor(random() * walls.length))]!;
  const roof = industrial
    ? // Works and foundries are iron-and-glass sheds, in every register.
      random() < 0.5
      ? 'iron'
      : 'glass'
    : roofs[Math.min(roofs.length - 1, Math.floor(random() * roofs.length))]!;
  return { wall, roof };
}

/** Shortest-arc hue interpolation, so 350° → 10° goes through 0 and not 180. */
export function mixHue(from: number, to: number, t: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  delta *= t;
  return (((from + delta) % 360) + 360) % 360;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/**
 * How far a wall's lightness may swing away from its roof's. The base
 * roof/facade gap is 14 points, and `palette.test.ts` demands the treated gap
 * stay comfortably positive, so this is the headroom a wall material gets to
 * express itself in without flattening the building.
 */
const WALL_LIT_SWING = 4;

/** The wall's lightness shift, anchored to the roof's so the two can never
 *  converge. See the module header. */
export function wallLitDelta(wall: MaterialKey, roof: MaterialKey): number {
  const roofDelta = MATERIAL[roof].litDelta;
  const want = MATERIAL[wall].litDelta - roofDelta;
  return roofDelta + Math.max(-WALL_LIT_SWING, Math.min(WALL_LIT_SWING, want));
}

/**
 * Apply a material to a surface's HSL. `hueKeep` is how much of the language
 * hue survives — 1 keeps it entirely (roofs), lower values pull toward the
 * material (walls in the dense core). `litDelta` overrides the material's own
 * lightness shift, which is how walls stay anchored to their roof.
 */
export function applyMaterial(
  base: Hsl,
  material: MaterialKey,
  hueKeep: number,
  litDelta = MATERIAL[material].litDelta,
): Hsl {
  const m = MATERIAL[material];
  const pull = m.hueMix * (1 - Math.max(0, Math.min(1, hueKeep)));
  return {
    h: mixHue(base.h, m.hue, pull),
    s: Math.max(0, Math.min(100, base.s * m.satMul)),
    l: Math.max(0, Math.min(100, base.l + litDelta)),
  };
}

/** HSL → the exact `hsl(H S% L%)` shape the rest of the renderer emits.
 *  Components must be integers: `palette.test.ts` parses them with a regex that
 *  rejects decimals, and the DiamondBatcher buckets on the string. */
export function hsl({ h, s, l }: Hsl): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

/**
 * How much of the language hue a WALL keeps, by urbanity. The one place the
 * continuous field feeds color: a hamlet wall is essentially language-hued
 * limewash, a city wall is mostly brick or stone.
 */
export function wallHueKeep(urbanity: number): number {
  const t = Math.max(0, Math.min(1, urbanity));
  return 0.85 + (0.3 - 0.85) * t;
}
