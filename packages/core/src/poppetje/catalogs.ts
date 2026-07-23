/**
 * Poppetje catalogs — every option the figure renderer knows how to draw.
 *
 * Single source of truth shared by the service (persists resolved structs),
 * the seed generator (picks from these arrays), and the UI renderer (looks
 * up archetype dimensions). Originally ported from the renderer handoff; see
 * `docs/poppetje-rendering.md` for the maintained visual contract.
 */

import type { GezelGender } from '../schemas/gezel.js';

/** Width control points (5) for each body silhouette, in the 80-wide viewBox. */
export interface BodyArchetype {
  baseW: number;
  hipW: number;
  waistW: number;
  chestW: number;
  shoulderW: number;
  label: string;
  note: string;
}

/**
 * Width control points (5) per body archetype, in the 80-wide viewBox.
 * Earlier versions clustered all six within ~10 units of each other, so
 * `broad` / `athletic` / `stout` were nearly indistinguishable silhouettes.
 * Spread them out — and in particular, give `broad` and `athletic` actual
 * shoulder width (the original `broad: shoulderW=42` pinched at the top,
 * which directly contradicted its "broad through the shoulders" brief).
 */
export const BODY_ARCHETYPES: Record<string, BodyArchetype> = {
  broad: {
    baseW: 46,
    hipW: 52,
    waistW: 52,
    chestW: 56,
    shoulderW: 54,
    label: 'broad',
    note: 'Barrel torso, broad through the shoulders. Reads adult, sturdy.',
  },
  tapered: {
    baseW: 58,
    hipW: 52,
    waistW: 46,
    chestW: 38,
    shoulderW: 32,
    label: 'tapered',
    note: 'Classic peg-doll cone. Wide base, smooth taper to a narrow top.',
  },
  curvy: {
    baseW: 48,
    hipW: 60,
    waistW: 34,
    chestW: 46,
    shoulderW: 36,
    label: 'curvy',
    note: 'Hourglass — hip flare, pinched waist, narrower shoulders.',
  },
  athletic: {
    baseW: 38,
    hipW: 40,
    waistW: 42,
    chestW: 54,
    shoulderW: 56,
    label: 'athletic',
    note: 'V-shape. Wider chest and shoulders, narrower waist and hips.',
  },
  slender: {
    baseW: 46,
    hipW: 42,
    waistW: 34,
    chestW: 36,
    shoulderW: 32,
    label: 'slender',
    note: 'Narrow throughout. Reads tall and lean.',
  },
  stout: {
    baseW: 62,
    hipW: 64,
    waistW: 62,
    chestW: 58,
    shoulderW: 50,
    label: 'stout',
    note: 'Wide throughout. Reads grounded, generous.',
  },
};

export const BODY_SHAPE_KEYS = Object.keys(BODY_ARCHETYPES) as BodyShape[];
export type BodyShape = 'broad' | 'tapered' | 'curvy' | 'athletic' | 'slender' | 'stout';

export interface FigureScaleDef {
  bodyScale: number;
  headScale: number;
  label: string;
  note: string;
}

export const FIGURE_SCALES: Record<string, FigureScaleDef> = {
  adult: { bodyScale: 1.0, headScale: 1.0, label: 'adult', note: 'Standard crew member.' },
  shorter: {
    bodyScale: 0.88,
    headScale: 0.98,
    label: 'shorter',
    note: 'Older or simply shorter adult.',
  },
  child: {
    bodyScale: 0.78,
    headScale: 0.96,
    label: 'child',
    note: 'Short body, head reads proportionally larger.',
  },
  toddler: { bodyScale: 0.76, headScale: 0.95, label: 'toddler', note: 'Smallest. Mostly head.' },
};

export const FIGURE_SCALE_KEYS = Object.keys(FIGURE_SCALES) as FigureScale[];
export type FigureScale = 'adult' | 'shorter' | 'child' | 'toddler';

/** Wood-grain filter presets. Tune displacement, alpha, and streak frequency together. */
export interface GrainPreset {
  skip?: boolean;
  dispScale?: number;
  /** Strength of the translucent grain tint after fiber contrast. */
  opacity?: number;
  /** Small blur applied after displacement so fibers read through paint. */
  soften?: number;
  streakFreq?: string;
}

/**
 * Wood-grain finish presets. The stable key adds a separate material
 * character (fine, flowing, cathedral, or knotty) inside each finish.
 * Texture should remain below facial features, but must still be visible at
 * the full-figure sizes used in detail views and galleries.
 */
export const GRAIN_PRESETS: Record<string, GrainPreset> = {
  none: { skip: true },
  straight: { dispScale: 0, opacity: 0.18, soften: 0.28, streakFreq: '0.13 0.018' },
  wavy: { dispScale: 3.2, opacity: 0.23, soften: 0.3, streakFreq: '0.12 0.016' },
  pronounced: { dispScale: 4.8, opacity: 0.31, soften: 0.24, streakFreq: '0.14 0.018' },
  character: { dispScale: 6.4, opacity: 0.42, soften: 0.18, streakFreq: '0.16 0.02' },
};

export type GrainStyle = 'none' | 'straight' | 'wavy' | 'pronounced' | 'character';

export const HAT_OPTIONS = ['cap', 'beanie', 'kerchief', 'straw', 'newsboy', 'hood'] as const;
export type HatOption = (typeof HAT_OPTIONS)[number];

export const DRESS_OPTIONS = ['scarf', 'apron', 'collar', 'turtleneck'] as const;
export type DressOption = (typeof DRESS_OPTIONS)[number];

export const HAIR_SHAPES = ['halo', 'short', 'long', 'bun', 'braids', 'shaved', 'bald'] as const;
export type HairShape = (typeof HAIR_SHAPES)[number];

/**
 * Wearable accessories — things a gezel can put on or take off, so
 * they're user-toggleable from the appearance dialog. Physical facial
 * features (facial hair, freckles, moles) deliberately live in their own
 * slots below and only ever change on a reroll.
 *
 * Earring sides are named from the VIEWER's perspective (what you see in
 * the preview), not the wearer's; `earrings` is the both-ears default.
 * Legacy `accessory: 'earring'` files migrate to `earrings` on read.
 * Hair-zone accessories (flower, hairclip, headband, feather, pencil, ribbon)
 * hide while a hat is worn — same rule as hair itself.
 */
export const ACCESSORY_OPTIONS = [
  'glasses',
  'sunglasses',
  'cateye',
  'readers',
  'monocle',
  'eyepatch',
  'earrings',
  'earring-left',
  'earring-right',
  'flower',
  'hairclip',
  'headband',
  'bowtie',
  'necklace',
  'brooch',
  'facemask',
  'goggles',
  'safety-glasses',
  'pince-nez',
  'headphones',
  'hearing-aid',
  'nose-ring',
  'hoop-earrings',
  'drop-earrings',
  'pearl-earrings',
  'bandage',
  'feather',
  'pencil',
  'ribbon',
  'necktie',
  'cravat',
  'bolo-tie',
  'lanyard',
  'medal',
  'pocket-square',
  'tool-pendant',
] as const;
export type AccessoryOption = (typeof ACCESSORY_OPTIONS)[number];

/**
 * Rarity tiers for *random* accessory assignment. The appearance dialog
 * still offers every option freely; these weights only bias the seed
 * generator so distinctive pieces (eyepatch, a single asymmetric earring)
 * stay rare instead of landing as often as plain glasses.
 */
export type AccessoryRarity = 'common' | 'uncommon' | 'rare' | 'veryRare';

/** Relative draw weights per tier. Higher = more likely. */
export const ACCESSORY_RARITY_WEIGHT: Record<AccessoryRarity, number> = {
  common: 12,
  uncommon: 6,
  rare: 2,
  veryRare: 0.5,
};

export interface AccessoryRarityEntry {
  rarity: AccessoryRarity;
  /** Per-gender overrides; falls back to `rarity` for any gender not listed. */
  byGender?: Partial<Record<GezelGender, AccessoryRarity>>;
}

/**
 * Per-accessory rarity. Everyday items (glasses, both-ear earrings, necklace)
 * stay common; novelty pieces are rare-to-very-rare. A single left- or
 * right-only earring is `rare` in general but `veryRare` on female gezels.
 */
export const ACCESSORY_RARITY: Record<AccessoryOption, AccessoryRarityEntry> = {
  glasses: { rarity: 'common' },
  sunglasses: { rarity: 'uncommon' },
  cateye: { rarity: 'uncommon' },
  readers: { rarity: 'uncommon' },
  monocle: { rarity: 'veryRare' },
  eyepatch: { rarity: 'veryRare' },
  earrings: { rarity: 'common' },
  'earring-left': { rarity: 'rare', byGender: { female: 'veryRare' } },
  'earring-right': { rarity: 'rare', byGender: { female: 'veryRare' } },
  flower: { rarity: 'uncommon' },
  hairclip: { rarity: 'uncommon' },
  headband: { rarity: 'uncommon' },
  bowtie: { rarity: 'rare' },
  necklace: { rarity: 'common' },
  brooch: { rarity: 'rare' },
  facemask: { rarity: 'rare' },
  goggles: { rarity: 'uncommon' },
  'safety-glasses': { rarity: 'common' },
  'pince-nez': { rarity: 'rare' },
  headphones: { rarity: 'common' },
  'hearing-aid': { rarity: 'common' },
  'nose-ring': { rarity: 'uncommon' },
  'hoop-earrings': { rarity: 'uncommon' },
  'drop-earrings': { rarity: 'uncommon' },
  'pearl-earrings': { rarity: 'common' },
  bandage: { rarity: 'uncommon' },
  feather: { rarity: 'uncommon' },
  pencil: { rarity: 'common' },
  ribbon: { rarity: 'common' },
  necktie: { rarity: 'common' },
  cravat: { rarity: 'rare' },
  'bolo-tie': { rarity: 'uncommon' },
  lanyard: { rarity: 'common' },
  medal: { rarity: 'rare' },
  'pocket-square': { rarity: 'uncommon' },
  'tool-pendant': { rarity: 'uncommon' },
};

/**
 * Per-dress rarity, reusing the shared {@link AccessoryRarity} tiers and
 * {@link ACCESSORY_RARITY_WEIGHT}. Everyday garments (scarf, collar,
 * turtleneck) stay common; the workshop apron is a `veryRare` novelty so it
 * seldom lands on a randomly seeded gezel. As with accessories, this only
 * biases the seed generator — the appearance dialog still offers every dress
 * freely. Dresses carry no per-gender overrides, so a flat tier map suffices.
 */
export const DRESS_RARITY: Record<DressOption, AccessoryRarity> = {
  scarf: 'common',
  apron: 'veryRare',
  collar: 'common',
  turtleneck: 'common',
};

/**
 * Facial hair — a physical feature, never user-toggleable. Split out of the
 * accessory slot so a gezel can wear glasses AND have a beard, and so the
 * appearance dialog can edit wearables without ever clobbering facial hair.
 * Gender-gated during seed generation (female gezels never auto-roll it).
 */
export const FACIAL_HAIR_OPTIONS = ['beard', 'mustache'] as const;
export type FacialHairOption = (typeof FACIAL_HAIR_OPTIONS)[number];

export const MARK_OPTIONS = ['freckles', 'mole'] as const;
export type MarkOption = (typeof MARK_OPTIONS)[number];

/**
 * Painted garment patterns — flat paint over the body silhouette, applied
 * under the wood grain so they read as decoration painted onto the carved
 * figure (not stickers floating above it). `plain` is the bare shirt.
 */
export const SHIRT_PATTERN_OPTIONS = [
  'plain',
  'buttons',
  'stripes',
  'sash',
  'yoke',
  'twotone',
] as const;
export type ShirtPattern = (typeof SHIRT_PATTERN_OPTIONS)[number];

/**
 * Felt palette for cloth hats (cap, beanie, kerchief, newsboy). Hats used
 * to render in the shirt's accent color, which camouflaged them into the
 * body — a hat should read as its own object, like the straw hat always
 * has. The felt is picked deterministically from the poppetje `key` (plus
 * the hat name), so a gezel's cap is the same red forever, but its beanie
 * — if a reroll ever lands one — gets an independent color.
 * `hood` deliberately stays in the shirt accent: it's part of the garment.
 */
export const HAT_FELTS = [
  { felt: '#a8554a', band: '#7c3a32' }, // brick red
  { felt: '#c9973f', band: '#96702c' }, // mustard
  { felt: '#5d7257', band: '#42523e' }, // forest
  { felt: '#4e6586', band: '#374a64' }, // navy
  { felt: '#43474e', band: '#2e3138' }, // charcoal
  { felt: '#8a5a78', band: '#64405a' }, // mulberry
] as const;

export const EXPRESSION_OPTIONS = ['smile', 'wider', 'neutral', 'wink', 'sleepy'] as const;
export type Expression = (typeof EXPRESSION_OPTIONS)[number];

/** Workshop palette — skin/skin2 pairs, hair colors, shirt/accent pairs. */
export const PALETTE = {
  skins: [
    { skin: '#ecd5b8', skin2: '#b8a080' }, // pale
    { skin: '#dbb898', skin2: '#a98870' }, // warm light
    { skin: '#e6c7a8', skin2: '#b89478' }, // tan light
    { skin: '#d4b896', skin2: '#a48c6c' }, // tan
    { skin: '#c79775', skin2: '#9d7050' }, // warm mid
    { skin: '#9c6b48', skin2: '#7a5236' }, // warm deep
    { skin: '#a87852', skin2: '#7d5436' }, // deep
    { skin: '#5d3a24', skin2: '#3d2418' }, // deeper
  ],
  hairs: [
    '#1a1410',
    '#2a1d12',
    '#3a2418',
    '#5a3a1c',
    '#7a5230',
    '#a87042',
    '#cc7744',
    '#d4a060',
    '#9a948a',
    '#dcd5c8',
    '#1f1812',
  ],
  /**
   * Shirt mid-tone + accent pairs. The wood-grain filter multiplies a warm
   * brown over the body, which costs every color a step of saturation and
   * value — the earlier palette was so muted that indigo, slate, plum, and
   * moss all converged to "gray robe" after the multiply. Mid-tones here
   * are kept a step brighter than the target on-screen color, and the hues
   * cover the full warm/cool wheel so a crew of poppetjes reads as a crowd
   * of different outfits at a glance.
   */
  shirts: [
    { shirt: '#94a87c', accent: '#5c6a4a' }, // sage
    { shirt: '#6d7d54', accent: '#46543a' }, // moss
    { shirt: '#d07c56', accent: '#9a4e30' }, // terracotta
    { shirt: '#b65843', accent: '#7e382a' }, // brick
    { shirt: '#d2a350', accent: '#9a6c28' }, // ochre
    { shirt: '#dcc06e', accent: '#a8863a' }, // butter
    { shirt: '#5b7cab', accent: '#2a4670' }, // indigo
    { shirt: '#549191', accent: '#2f5f5f' }, // teal
    { shirt: '#7d8794', accent: '#4a5360' }, // slate
    { shirt: '#9d6890', accent: '#5a3850' }, // plum
    { shirt: '#c28b8b', accent: '#8f5454' }, // rose
    { shirt: '#7a9a62', accent: '#4a6a3a' }, // leaf
  ],
} as const;

/** Slot odds tuned for balanced diversity in seed-based generation. */
export const SLOT_ODDS = {
  hat: 0.3,
  dress: 0.22,
  accessory: 0.5,
  facialHair: 0.18,
  mark: 0.2,
  /** Odds a figure gets any painted garment pattern (vs `plain`). */
  shirtPattern: 0.66,
} as const;

/**
 * Cumulative odds for the figure-scale roll. Height is the single
 * strongest silhouette differentiator the renderer has, and the seed
 * generator used to hardcode `adult` — every gezel stood exactly the
 * same height. Most figures are still adults; shorter and small figures
 * appear often enough that a crew lineup gets a varied skyline.
 */
export const FIGURE_SCALE_ODDS: ReadonlyArray<{ scale: FigureScale; upTo: number }> = [
  { scale: 'adult', upTo: 0.52 },
  { scale: 'shorter', upTo: 0.8 },
  { scale: 'child', upTo: 0.93 },
  { scale: 'toddler', upTo: 1 },
];
