import { z } from 'zod';
import { RectSchema } from './api.js';

/**
 * The durable "city file" — `.gezel/city.json` in a project's workspace (or
 * the project-local fallback). It is the source of truth for the code map's
 * placement memory; the sqlite `map_layout` table is a derived cache. Three
 * kinds of state live here:
 *
 * - anchors: macro memory ("packages/ lives NW"), recorded at first seed and
 *   honored by every later re-seed, so the user's mental map survives layout
 *   algorithm changes and index rebuilds.
 * - overrides: user-editable pins (region/rect for a folder, a building style
 *   for a path prefix).
 * - journal: the machine-maintained mirror of persisted layout nodes, compact
 *   enough to commit, complete enough to reconstruct the city after index
 *   loss (tombstones, transplants, and the age lens included).
 */

export const CompassRegionSchema = z.enum(['NW', 'N', 'NE', 'W', 'C', 'E', 'SW', 'S', 'SE']);
export type CompassRegion = z.infer<typeof CompassRegionSchema>;

/** Macro placement memory for one top-level display district. */
export const CityAnchorSchema = z.object({
  /** Top-level folder segment, e.g. 'packages'. */
  path: z.string().min(1),
  region: CompassRegionSchema,
  /** Normalized centroid at record time — ordering tiebreak when several
   *  districts share a region. */
  cx: z.number().min(0).max(1),
  cy: z.number().min(0).max(1),
  recordedAt: z.string(),
});
export type CityAnchor = z.infer<typeof CityAnchorSchema>;

/** User pin: force a folder to a region or exact rect, or a building style. */
export const CityOverrideSchema = z.object({
  path: z.string().min(1),
  region: CompassRegionSchema.optional(),
  /** World coords; wins over `region` when both are set. */
  rect: RectSchema.optional(),
  /** Renderer style token applied to blocks under this path prefix. */
  style: z.string().optional(),
});
export type CityOverride = z.infer<typeof CityOverrideSchema>;

/** One persisted layout node — the durable mirror of a `map_layout` row.
 *  Short keys keep the journal compact (anchors/overrides stay verbose —
 *  they're the human-facing half). Rects round to 0.1, matching `streetId`
 *  rounding so street ids survive a journal round-trip. */
export const CityJournalNodeSchema = z.object({
  k: z.enum(['block', 'street', 'plate', 'plaza']),
  id: z.string(),
  /** parentId. */
  p: z.string().nullable().optional(),
  /** contentHash (blocks only). */
  h: z.string().nullable().optional(),
  /** x, y, w, h. */
  r: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** weight (blocks: LoC; streets: tier). */
  w: z.number().optional(),
  /** placedAt. */
  a: z.string().nullable().optional(),
  /** removedAt (tombstone). */
  d: z.string().nullable().optional(),
});
export type CityJournalNode = z.infer<typeof CityJournalNodeSchema>;

/**
 * Sticky parameters of the urbanity field. Recorded like anchors: macro memory
 * the user's mental map depends on.
 *
 * These are re-adopted only when the field genuinely moves (see `adoptDowntown`
 * in the service). Recomputing them from scratch every build would let sub-ULP
 * float drift rewrite this file on every background indexer tick — a dirty git
 * diff, on a file explicitly designed to be committed.
 */
export const CityDowntownSchema = z.object({
  /** Importance-weighted centroid, world coords, rounded to 0.1. */
  cx: z.number(),
  cy: z.number(),
  /** Weighted radius of gyration, rounded to 0.1. */
  r: z.number().positive(),
  /** p90 of the blurred neighborhood-importance field, rounded to 3dp. */
  impRef: z.number().min(0),
  recordedAt: z.string(),
});
export type CityDowntown = z.infer<typeof CityDowntownSchema>;

export const CityDomainStateSchema = z.object({
  layoutVersion: z.number().int().positive(),
  seededAt: z.string(),
  anchors: z.array(CityAnchorSchema).default([]),
  journal: z.array(CityJournalNodeSchema).default([]),
  downtown: CityDowntownSchema.optional(),
});
export type CityDomainState = z.infer<typeof CityDomainStateSchema>;

export const CITY_FILE_ABOUT =
  'Gezel code-map placement memory. Committing this file keeps the city map ' +
  'stable across machines and index rebuilds. anchors/overrides are safe to ' +
  'hand-edit; journal is machine-maintained.';

export const CITY_FILE_SCHEMA_VERSION = 1;

export const CityFileSchema = z.object({
  schemaVersion: z.number().int().positive().default(CITY_FILE_SCHEMA_VERSION),
  about: z.string().default(CITY_FILE_ABOUT),
  updatedAt: z.string().optional(),
  overrides: z.array(CityOverrideSchema).default([]),
  /** Keyed by durable layout domain. Code and Tests persist independently;
   *  the All view is composed from them and needs no third journal. */
  domains: z.record(z.string(), CityDomainStateSchema).default({}),
});
export type CityFile = z.infer<typeof CityFileSchema>;
