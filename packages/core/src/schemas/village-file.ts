import { z } from 'zod';
import { RectSchema } from './api.js';

/**
 * The durable "village file" — `.gezel/village.json` in a project's workspace
 * (or the project-local fallback). It is the source of truth for the Village's
 * placement memory; the sqlite `map_layout` table is a derived cache. Three
 * kinds of state live here:
 *
 * - anchors: macro memory ("packages/ lives NW"), recorded at first seed and
 *   honored by every later re-seed, so the user's mental map survives layout
 *   algorithm changes and index rebuilds.
 * - overrides: user-editable pins (region/rect for a folder, a building style
 *   for a path prefix).
 * - journal: the machine-maintained mirror of persisted layout nodes, compact
 *   enough to commit, complete enough to reconstruct the village after index
 *   loss (tombstones, transplants, and the age lens included).
 *
 * ## No provenance timestamps
 *
 * This file is meant to be committed, so a rebuild that changes nothing must
 * produce no diff. Timestamps are the natural enemy of that: a `updatedAt`
 * stamped on every write, or a `recordedAt` on every anchor, guarantees a dirty
 * working tree after every background indexer tick even when the village is
 * bit-for-bit identical.
 *
 * So the file records a timestamp ONLY where the app reads one back:
 *
 * - `a` on a **block** — first placement, which drives the age lens.
 * - `d` on a **block** — removal, which drives tombstone pruning.
 *
 * Both change only when a file is genuinely added or deleted, which is a real
 * change and belongs in the diff. Everything else — when the village was
 * seeded, when an anchor was recorded, when the downtown was adopted — was
 * pure provenance that nothing ever consumed, and is gone.
 */

export const CompassRegionSchema = z.enum(['NW', 'N', 'NE', 'W', 'C', 'E', 'SW', 'S', 'SE']);
export type CompassRegion = z.infer<typeof CompassRegionSchema>;

/** Macro placement memory for one top-level display district. */
export const VillageAnchorSchema = z.object({
  /** Top-level folder segment, e.g. 'packages'. */
  path: z.string().min(1),
  region: CompassRegionSchema,
  /** Normalized centroid at record time — ordering tiebreak when several
   *  districts share a region. */
  cx: z.number().min(0).max(1),
  cy: z.number().min(0).max(1),
});
export type VillageAnchor = z.infer<typeof VillageAnchorSchema>;

/** User pin: force a folder to a region or exact rect, or a building style. */
export const VillageOverrideSchema = z.object({
  path: z.string().min(1),
  region: CompassRegionSchema.optional(),
  /** World coords; wins over `region` when both are set. */
  rect: RectSchema.optional(),
  /** Renderer style token applied to blocks under this path prefix. */
  style: z.string().optional(),
});
export type VillageOverride = z.infer<typeof VillageOverrideSchema>;

/** One persisted layout node — the durable mirror of a `map_layout` row.
 *  Short keys keep the journal compact (anchors/overrides stay verbose —
 *  they're the human-facing half). Rects round to 0.1, matching `streetId`
 *  rounding so street ids survive a journal round-trip. */
export const VillageJournalNodeSchema = z.object({
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
  /** placedAt — BLOCKS ONLY, and the age lens reads it. Derived nodes
   *  (streets, plates, plazas) carry no timestamp: nothing consumes theirs,
   *  and restamping them churned the file on every build. */
  a: z.string().nullable().optional(),
  /** removedAt (tombstone) — blocks only; drives the 14-day prune. */
  d: z.string().nullable().optional(),
});
export type VillageJournalNode = z.infer<typeof VillageJournalNodeSchema>;

/**
 * Sticky parameters of the urbanity field. Recorded like anchors: macro memory
 * the user's mental map depends on.
 *
 * These are re-adopted only when the field genuinely moves (see `adoptDowntown`
 * in the service). Recomputing them from scratch every build would let sub-ULP
 * float drift rewrite this file on every background indexer tick — a dirty git
 * diff, on a file explicitly designed to be committed.
 */
export const VillageDowntownSchema = z.object({
  /** Importance-weighted centroid, world coords, rounded to 0.1. */
  cx: z.number(),
  cy: z.number(),
  /** Weighted radius of gyration, rounded to 0.1. */
  r: z.number().positive(),
  /** p90 of the blurred neighborhood-importance field, rounded to 3dp. */
  impRef: z.number().min(0),
});
export type VillageDowntown = z.infer<typeof VillageDowntownSchema>;

export const VillageDomainStateSchema = z.object({
  layoutVersion: z.number().int().positive(),
  anchors: z.array(VillageAnchorSchema).default([]),
  journal: z.array(VillageJournalNodeSchema).default([]),
  downtown: VillageDowntownSchema.optional(),
});
export type VillageDomainState = z.infer<typeof VillageDomainStateSchema>;

export const VILLAGE_FILE_ABOUT =
  'Gezel Village placement memory. Committing this file keeps the village ' +
  'stable across machines and index rebuilds. anchors/overrides are safe to ' +
  'hand-edit; journal is machine-maintained. Deliberately free of provenance ' +
  'timestamps so an unchanged rebuild produces no diff.';

export const VILLAGE_FILE_SCHEMA_VERSION = 1;

export const VillageFileSchema = z.object({
  schemaVersion: z.number().int().positive().default(VILLAGE_FILE_SCHEMA_VERSION),
  about: z.string().default(VILLAGE_FILE_ABOUT),
  overrides: z.array(VillageOverrideSchema).default([]),
  /** Keyed by durable layout domain. Code and Tests persist independently;
   *  the All view is composed from them and needs no third journal. */
  domains: z.record(z.string(), VillageDomainStateSchema).default({}),
});
export type VillageFile = z.infer<typeof VillageFileSchema>;
