import { z } from 'zod';
import {
  ACCESSORY_OPTIONS,
  BODY_SHAPE_KEYS,
  DRESS_OPTIONS,
  EXPRESSION_OPTIONS,
  FACIAL_HAIR_OPTIONS,
  FIGURE_SCALE_KEYS,
  HAIR_SHAPES,
  HAT_OPTIONS,
  MARK_OPTIONS,
  SHIRT_PATTERN_OPTIONS,
} from './catalogs.js';

/**
 * Migrate poppetje JSON written before facial hair / marks were split out
 * of the `accessory` slot. Older files stored `accessory: 'beard'` (and
 * 'mustache' / 'freckles' / 'mole'); fold those into their dedicated slots
 * so the narrowed `accessory` enum still parses and no character loses a
 * feature. New values pass through untouched. Runs on every read; the
 * manager re-persists the normalized form on the next write.
 */
function migrateLegacyAccessory(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const acc = r.accessory;
  if (acc === 'beard' || acc === 'mustache') {
    if (r.facialHair == null) r.facialHair = acc;
    r.accessory = null;
  } else if (acc === 'freckles' || acc === 'mole') {
    if (r.mark == null) r.mark = acc;
    r.accessory = null;
  } else if (acc === 'earring') {
    // The single `earring` option split into `earrings` (both ears, the
    // default) plus explicit left/right singles.
    r.accessory = 'earrings';
  }
  return r;
}

/**
 * A resolved poppetje — the carved-figure character data for a gezel.
 * Stored explicitly on disk so adding new catalog entries or tuning slot
 * odds later never drifts existing characters. The renderer reads from
 * this struct; the seed generator produces it.
 */
export const PoppetjeSchema = z.preprocess(
  migrateLegacyAccessory,
  z.object({
    /** Stable id; locks the wood-grain noise seed. Pin to the gezel id at creation. */
    key: z.string().min(1),
    name: z.string(),

    bodyShape: z.enum(BODY_SHAPE_KEYS as [string, ...string[]]),
    figureScale: z.enum(FIGURE_SCALE_KEYS as [string, ...string[]]),

    /** Mid-tone of the head. Paired with skin2 for the lateral gradient. */
    skin: z.string(),
    /** Darker edge tone. */
    skin2: z.string(),

    hair: z.string(),
    hairShape: z.enum(HAIR_SHAPES),

    /** Replaces hair when set; 'hood' renders at body level. */
    hat: z.enum(HAT_OPTIONS).nullable().optional().default(null),
    /** Body overlay; null for an unadorned shirt. */
    dress: z.enum(DRESS_OPTIONS).nullable().optional().default(null),
    /** Wearable face accessory (glasses, earring, monocle). User-toggleable. */
    accessory: z.enum(ACCESSORY_OPTIONS).nullable().optional().default(null),
    /** Facial hair (beard, mustache). Physical — reroll-only. */
    facialHair: z.enum(FACIAL_HAIR_OPTIONS).nullable().optional().default(null),
    /** Small facial detail (freckles, mole). Physical — reroll-only. */
    mark: z.enum(MARK_OPTIONS).nullable().optional().default(null),
    expression: z.enum(EXPRESSION_OPTIONS).optional().default('smile'),

    shirt: z.string(),
    shirtAccent: z.string(),
    /**
     * Painted garment pattern over the shirt (buttons, stripes, sash, …).
     * Files written before patterns existed parse as `plain` — the bare
     * shirt those characters always had.
     */
    shirtPattern: z.enum(SHIRT_PATTERN_OPTIONS).optional().default('plain'),
  }),
);
export type Poppetje = z.infer<typeof PoppetjeSchema>;
