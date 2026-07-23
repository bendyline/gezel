import { GROWTH_COSMETICS, type GrowthCosmetic } from '../growth-cosmetics.js';
import type { GezelGender } from '../schemas/gezel.js';
import type { AccessoryOption, DressOption } from './catalogs.js';
import {
  ACCESSORY_OPTIONS,
  ACCESSORY_RARITY,
  ACCESSORY_RARITY_WEIGHT,
  BODY_SHAPE_KEYS,
  DRESS_OPTIONS,
  DRESS_RARITY,
  EXPRESSION_OPTIONS,
  FACIAL_HAIR_OPTIONS,
  FIGURE_SCALE_ODDS,
  HAIR_SHAPES,
  HAT_OPTIONS,
  PALETTE,
  SHIRT_PATTERN_OPTIONS,
  SLOT_ODDS,
} from './catalogs.js';
import type { Poppetje } from './schema.js';

/**
 * Strip the level-gated growth cosmetics out of a slot's option pool.
 *
 * The random generator runs at level 1 — both at birth
 * ({@link initialPoppetjeForGezel}) and on every reroll — so it must never
 * assign a growth cosmetic (Hood at Lv 7, Workshop apron at Lv 5, Monocle at
 * Lv 4, …). If it did, the gezel would wear an item it can't reselect once
 * removed in the accessory dialog: the dialog grandfathers a worn-but-locked
 * piece, but the moment you click it off, its "unlocks at level N" gate slams
 * shut (see GezelDetail's `lockedForSlot`). Growth cosmetics are *earned* and
 * explicitly chosen, never rolled. {@link GROWTH_COSMETICS} is the single
 * source of truth for what's gated.
 */
function rollablePool<T extends string>(options: readonly T[], slot: GrowthCosmetic['slot']): T[] {
  const gated = new Set(GROWTH_COSMETICS.filter((c) => c.slot === slot).map((c) => c.option));
  return options.filter((opt) => !gated.has(opt));
}

/** Catalog options the generator may roll — growth cosmetics filtered out. */
export const ROLLABLE_HATS = rollablePool(HAT_OPTIONS, 'hat');
export const ROLLABLE_DRESSES = rollablePool(DRESS_OPTIONS, 'dress');
export const ROLLABLE_ACCESSORIES = rollablePool(ACCESSORY_OPTIONS, 'accessory');

/**
 * djb2 hash → [0, 100). Used as the SVG turbulence `seed` attribute so
 * every gezel with the same `key` gets the same wood-grain pattern,
 * forever, across every render and every viewBox crop.
 */
export function seedFromKey(key: string): number {
  let h = 5381;
  const s = String(key || 'x');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return Math.abs(h) % 100;
}

/**
 * Mix a seed integer with a per-slot offset into a well-distributed uint32.
 *
 * Every multiply is `Math.imul` (true 32-bit integer math). The predecessor
 * did `n * 2654435761` in float64: for a hash-sized `n` (~2^32) the product
 * reaches ~2^63, overflowing float64's 53-bit mantissa, so the low ~10 bits
 * were silently rounded to zero. Because `idx`'s `% len` reads exactly those
 * dead low bits, every even-length pool collapsed — skin (8) reachable only
 * as 2 of 8 tones, body (6) as 3 of 6, mark/facialHair (2) pinned to a single
 * constant — while odd-length pools (hair 11, hairShape 7) stayed fine. It hid
 * for years because the seed tests sweep only small consecutive `n`, where the
 * float multiply is still exact; the real breakage was on the hashed-id path
 * (`initialPoppetjeForGezel`). See the distribution guard in seed.test.ts.
 */
function mix(n: number, offset: number): number {
  let h = Math.imul((n >>> 0) ^ 0x9e3779b9, 2654435761);
  h = Math.imul((h ^ (h >>> 15)) + (offset | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function idx(n: number, offset: number, len: number): number {
  return mix(n, offset) % len;
}

// XOR the offset into a distinct domain so `roll(n, k)` never correlates with
// `idx(n, k)` for a shared slot offset.
function roll(n: number, offset: number): number {
  return (mix(n, offset ^ 0x2545f491) % 1000) / 1000;
}

/** Indexed pick from a non-empty readonly array. Throws if `arr` is empty — but our catalogs are constants and never are. */
function pickFrom<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) {
    throw new Error(`poppetje catalog lookup out of range: ${i}/${arr.length}`);
  }
  return v;
}

/** Resolve an accessory's draw weight, honoring any per-gender rarity override. */
function resolveAccessoryWeight(opt: AccessoryOption, gender?: GezelGender): number {
  const entry = ACCESSORY_RARITY[opt];
  const tier = (gender && entry.byGender?.[gender]) ?? entry.rarity;
  return ACCESSORY_RARITY_WEIGHT[tier];
}

/**
 * Deterministic, rarity-weighted accessory pick. `r` is a `roll()` value in
 * [0, 1). Common items dominate; eyepatch and single-side earrings (very rare,
 * extra-rare for female gezels) seldom land. Mirrors the cumulative-subtraction
 * weighting in `pickKokoroVoiceForGender`.
 */
function pickAccessory(r: number, gender?: GezelGender): AccessoryOption {
  const total = ROLLABLE_ACCESSORIES.reduce(
    (sum, opt) => sum + resolveAccessoryWeight(opt, gender),
    0,
  );
  let pick = r * total;
  for (const opt of ROLLABLE_ACCESSORIES) {
    pick -= resolveAccessoryWeight(opt, gender);
    if (pick < 0) return opt;
  }
  return ROLLABLE_ACCESSORIES[ROLLABLE_ACCESSORIES.length - 1]!;
}

/**
 * Deterministic, rarity-weighted dress pick — same cumulative-subtraction
 * scheme as {@link pickAccessory}, but dresses have no per-gender overrides.
 * Keeps the workshop apron a rare find instead of landing as often as a scarf.
 */
function pickDress(r: number): DressOption {
  const weight = (opt: DressOption) => ACCESSORY_RARITY_WEIGHT[DRESS_RARITY[opt]];
  const total = ROLLABLE_DRESSES.reduce((sum, opt) => sum + weight(opt), 0);
  let pick = r * total;
  for (const opt of ROLLABLE_DRESSES) {
    pick -= weight(opt);
    if (pick < 0) return opt;
  }
  return ROLLABLE_DRESSES[ROLLABLE_DRESSES.length - 1]!;
}

export interface PoppetjeSeedOptions {
  /** When provided, becomes the resulting `Poppetje.key` (stable wood-grain seed). */
  key?: string;
  /** When provided, becomes the resulting `Poppetje.name`. */
  name?: string;
  /**
   * When `'female'`, the generator omits `beard` and `mustache` from the
   * accessory pool. Other genders (`'male'`, `'non-binary'`, `undefined`)
   * keep the full pool. The brief is explicit that body shape, skin,
   * hair, hat, dress, and expression are **never** tied to gender —
   * only facial hair gets this anatomical gate.
   */
  gender?: GezelGender;
}

/**
 * Produce a deterministic, complete `Poppetje` from a single integer seed.
 *
 * Same `n` always returns the same struct. Slot odds (hat 30%, dress 22%,
 * accessory 50%, mark 20%) are applied via independent rolls so each slot
 * is empty-or-filled independent of the others.
 *
 * `options.key` and `options.name` let you decouple the wood-grain seed
 * (the `key` field — locked to the gezel id) from the catalog seed `n`
 * (the random integer that picks slots). Without an explicit key, the
 * generator falls back to `seed-${n}`.
 */
export function poppetjeFromSeed(n: number, options: PoppetjeSeedOptions = {}): Poppetje {
  const skinPick = pickFrom(PALETTE.skins, idx(n, 1, PALETTE.skins.length));
  const shirtPick = pickFrom(PALETTE.shirts, idx(n, 2, PALETTE.shirts.length));
  const body = pickFrom(BODY_SHAPE_KEYS, idx(n, 3, BODY_SHAPE_KEYS.length));
  const hair = pickFrom(PALETTE.hairs, idx(n, 4, PALETTE.hairs.length));
  const hairShape = pickFrom(HAIR_SHAPES, idx(n, 5, HAIR_SHAPES.length));

  const hat =
    roll(n, 6) < SLOT_ODDS.hat ? pickFrom(ROLLABLE_HATS, idx(n, 7, ROLLABLE_HATS.length)) : null;
  // Dress garment — the 22% slot roll fires independently, but *which* dress
  // is rarity-weighted so the workshop apron stays a rare find (see DRESS_RARITY).
  const dress = roll(n, 8) < SLOT_ODDS.dress ? pickDress(roll(n, 9)) : null;
  // Wearable accessory (glasses / earring / monocle) — the 50% slot roll is
  // never gender-gated, but *which* accessory is rarity-weighted: distinctive
  // pieces (eyepatch, a single asymmetric earring) stay rare, and single-side
  // earrings are extra-rare for female gezels (see ACCESSORY_RARITY).
  const accessory =
    roll(n, 10) < SLOT_ODDS.accessory ? pickAccessory(roll(n, 11), options.gender) : null;
  // Facial hair is a physical feature, so it carries the female gate the
  // brief calls for — only beard/mustache are anatomical, never tied to
  // skin, hair, hat, or dress.
  const facialHair =
    options.gender !== 'female' && roll(n, 15) < SLOT_ODDS.facialHair
      ? pickFrom(FACIAL_HAIR_OPTIONS, idx(n, 16, FACIAL_HAIR_OPTIONS.length))
      : null;
  const mark =
    roll(n, 12) < SLOT_ODDS.mark
      ? idx(n, 13, 2) === 0
        ? ('freckles' as const)
        : ('mole' as const)
      : null;
  const expression = pickFrom(EXPRESSION_OPTIONS, idx(n, 14, EXPRESSION_OPTIONS.length));

  // Height roll — the strongest silhouette differentiator. Weighted toward
  // adult, but a crew lineup should have a varied skyline.
  const scaleRoll = roll(n, 17);
  const figureScale = (FIGURE_SCALE_ODDS.find((o) => scaleRoll <= o.upTo) ??
    FIGURE_SCALE_ODDS[FIGURE_SCALE_ODDS.length - 1])!.scale;

  // Painted garment pattern — `plain` stays common, the rest spread evenly.
  const patterned = SHIRT_PATTERN_OPTIONS.filter((p) => p !== 'plain');
  const shirtPattern =
    roll(n, 18) < SLOT_ODDS.shirtPattern
      ? pickFrom(patterned, idx(n, 19, patterned.length))
      : 'plain';

  return {
    key: options.key ?? `seed-${n}`,
    name: options.name ?? `Seed #${n}`,
    bodyShape: body,
    figureScale,
    skin: skinPick.skin,
    skin2: skinPick.skin2,
    hair,
    hairShape,
    hat,
    dress,
    accessory,
    facialHair,
    mark,
    expression,
    shirt: shirtPick.shirt,
    shirtAccent: shirtPick.accent,
    shirtPattern,
  };
}

/**
 * First-time poppetje for a gezel — deterministic from the gezel id alone.
 *
 * Hashes the gezel id to a catalog seed `n`, then runs `poppetjeFromSeed`
 * with `key` pinned to the id. Reproducible across tests, restarts, and
 * migrations. After this initial state, the user can reroll to draw a
 * fresh `n` — but the `key` (and so the wood-grain pattern) stays pinned.
 */
export function initialPoppetjeForGezel(
  gezelId: string,
  name: string,
  gender?: GezelGender,
): Poppetje {
  // Use a different prime than seedFromKey so the wood-grain seed and the
  // catalog-picking seed don't share a low-order-bit relationship.
  let h = 2166136261; // FNV-1a basis
  for (let i = 0; i < gezelId.length; i++) {
    h ^= gezelId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const n = Math.abs(h) >>> 0;
  return poppetjeFromSeed(n, { key: gezelId, name, gender });
}
