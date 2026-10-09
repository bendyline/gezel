import { z } from 'zod';

// ── file-map (the Village: a folder tree as a 1890–1915 settlement) ─────────

/** A rectangle in map-space (arbitrary units; the renderer fits to viewport). */
export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

/** A neighborhood — a folder, drawn as a padded box enclosing its blocks. */
export const MapDistrictSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  rect: RectSchema,
  label: z.string(),
  depth: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  weight: z.number().nonnegative(),
  color: z.string().optional(),
  /** Reserved label plate in world coords — the renderer draws the district
   *  label here and never guesses a position. Present on display districts. */
  labelPlate: RectSchema.optional(),
  /** Label for a collapsed pass-through folder chain, relative to the parent
   *  display district (e.g. 'service/src'). Absent ⇒ don't label this
   *  district — collapsed chains are labeled exactly once. */
  displayLabel: z.string().optional(),
});
export type MapDistrict = z.infer<typeof MapDistrictSchema>;

/** Health + zoning verdicts for a block — facts plus server-computed policy.
 *  The renderer maps `vibe`/`zone` to decoration 1:1 and never re-derives
 *  thresholds, so policy can evolve without client changes. */
export const MapBlockHealthSchema = z.object({
  /** Static security findings on this file (all severities). */
  findings: z.number().int().nonnegative(),
  maxSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).nullable(),
  /** How many in-repo files import this one / it imports. */
  fanIn: z.number().int().nonnegative(),
  fanOut: z.number().int().nonnegative(),
  /** Groundskeeping verdict: drives trees vs weeds in the yard. */
  vibe: z.enum(['lush', 'tidy', 'plain', 'scruffy', 'blighted']),
  /** Dependency-role zoning: drives the building type (roof treatment).
   *  civic = hub everyone imports; commercial = widely shared; industrial =
   *  big machinery by LoC; residential = leaf consumers. */
  zone: z.enum(['residential', 'commercial', 'civic', 'industrial']),
  /** Transitive import centrality (PageRank over the resolved import graph,
   *  max-normalized so the top hub is 1.0). Absent when there are no edges. */
  importance: z.number().min(0).max(1).optional(),
  /** Commits touching this file in the churn window (window length rides in
   *  `FileMapResponse.signals.churnWindowDays`). Absent when git is
   *  unavailable for the workspace. */
  churn: z.number().int().nonnegative().optional(),
});
export type MapBlockHealth = z.infer<typeof MapBlockHealthSchema>;

/** How urban the ground under a block is. See `MapBlockSchema.settlement`. */
export const SettlementSchema = z.enum(['hamlet', 'village', 'town', 'city']);
export type Settlement = z.infer<typeof SettlementSchema>;

/**
 * A block — a file. Size ∝ lines of code; `state` drives construction/rubble.
 *
 * Five orthogonal signals drive the renderer, each answering a different
 * question. Keep them separate — collapsing any two makes the settlement read
 * as one undifferentiated mass:
 *
 * | field              | question                                | renders as              |
 * |--------------------|-----------------------------------------|-------------------------|
 * | `health.zone`      | what does this file *do*?               | archetype family        |
 * | `levels`           | how important is this *file*?           | storeys                 |
 * | `landmark`         | which few files are the *skyline*?      | guildhall / town hall   |
 * | `health.vibe`      | how well *kept* is it?                  | trees vs weeds          |
 * | `urbanity`         | what kind of *place* is it standing in? | ground, materials, surroundings |
 */
export const MapBlockSchema = z.object({
  id: z.string(),
  districtId: z.string(),
  rect: RectSchema,
  label: z.string(),
  weight: z.number().nonnegative(),
  kind: z.string().nullable().optional(),
  lang: z.string().nullable().optional(),
  state: z.enum(['live', 'new', 'tombstoned']),
  buildingCount: z.number().int().nonnegative(),
  /** A PR-overlay placeholder for a file the PR adds that isn't indexed yet
   *  ("new construction") — drawn dashed and excluded from codebase stats. */
  phantom: z.boolean().optional(),
  /** ISO timestamp of the block's first placement on the map (persisted
   *  across builds). Drives the age lens; null on pre-timestamp layouts. */
  placedAt: z.string().nullable().optional(),
  /** The parcel containing the footprint (`rect`) plus yard margins — the
   *  collision/persistence unit. Frozen across builds; the footprint regrows
   *  inside it (clamped, so a huge file saturates instead of overlapping). */
  lot: RectSchema.optional(),
  /** Health/zoning verdicts (absent on tombstones and pre-health payloads). */
  health: MapBlockHealthSchema.optional(),
  /** Storeys, 1..5 — server policy from importance + LoC + churn. The
   *  renderer maps levels to extrusion 1:1 and never re-derives. Absent on
   *  tombstones, phantoms, and pre-V3 payloads. */
  levels: z.number().int().min(1).max(5).optional(),
  /** Skyline landmark: the centrality-ranked head of the civic zone. Gets a
   *  plaza in the layout and landmark treatment in the renderer. */
  landmark: z.boolean().optional(),
  /** Last git commit touching this file (ISO). The age lens prefers this
   *  over `placedAt`. Absent when git is unavailable. */
  lastTouchedAt: z.string().optional(),
  /** Urbanity of the ground under this parcel, 0..1 — server policy blending
   *  downtown proximity, local build density, and NEIGHBORHOOD importance,
   *  capped by project size. Deliberately continuous: the renderer LERPS with
   *  it (prop density, vegetation, wall hue mix, bay rhythm) and never compares
   *  it to a constant. Absent on tombstones, phantoms, and pre-V6 payloads.
   *
   *  It samples the neighborhood, never this block's own importance — that
   *  already drives `levels`, and counting it twice makes the core an
   *  undifferentiated wall of tall civic buildings. */
  urbanity: z.number().min(0).max(1).optional(),
  /** Bucketed `urbanity` — the ONLY input to categorical choices (paving,
   *  wall/roof material, within-family archetype pick, hedge vs fence vs
   *  curb). Thresholds live in the service; never re-derive them client-side
   *  from `urbanity`, or they drift the first time the policy is tuned. */
  settlement: SettlementSchema.optional(),
});
export type MapBlock = z.infer<typeof MapBlockSchema>;

/** A building — one function/class/symbol inside a block. */
export const MapBuildingSchema = z.object({
  id: z.string(),
  blockId: z.string(),
  rect: RectSchema,
  /** Normalized [0,1] on an ABSOLUTE log scale over the symbol's line span
   *  (floored so every building is visible) — comparable across files, unlike
   *  the pre-v5 per-file-relative value. Renderers map it to extrusion. */
  height: z.number().nonnegative(),
  /** Line span of the symbol (absent on pre-v5 payloads). */
  lines: z.number().int().positive().optional(),
  /** 1-based source range of the symbol (absent on pre-v6 payloads). */
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  label: z.string(),
  kind: z.string(),
});
export type MapBuilding = z.infer<typeof MapBuildingSchema>;

/** A street — the materialized gap between sibling folders / parcel rows.
 *  tier 0 = avenue between top-level packages … 3 = lane/alley in a folder. */
export const MapStreetSchema = z.object({
  id: z.string(),
  /** Axis-aligned; w > h ⇒ a horizontal street. */
  rect: RectSchema,
  tier: z.number().int().min(0).max(3),
  /** Folder whose interior this street runs through; null at the map root. */
  districtId: z.string().nullable(),
  /** Estimated flow: the import degree of every parcel fronting the street
   *  plus everything that leaves the folders it bounds. Server policy from
   *  [service/filemap/traffic.ts]; absent on pre-traffic payloads. */
  traffic: z.number().nonnegative().optional(),
  /** Road grade 0..7, bucketed from `traffic` and capped by the settlement:
   *  narrow dirt → narrow cobble → narrow paved → wide dirt → wide paved →
   *  wide paved with sidewalks → broad paved with sidewalks → broad paved
   *  with trolley and sidewalks. The renderer maps it to carriageway width,
   *  surface, and street furniture 1:1 and never re-derives thresholds. */
  grade: z.number().int().min(0).max(7).optional(),
});
export type MapStreet = z.infer<typeof MapStreetSchema>;

/** A plaza or green — reserved open ground the layout never builds on.
 *  `plaza` fronts a landmark block; `green` fills a district's leftover
 *  packing space so neighborhoods breathe. */
export const MapPlazaSchema = z.object({
  id: z.string(),
  districtId: z.string().nullable(),
  rect: RectSchema,
  kind: z.enum(['plaza', 'green']),
  /** The landmark block this plaza fronts (absent for greens). */
  blockId: z.string().optional(),
});
export type MapPlaza = z.infer<typeof MapPlazaSchema>;

/** A road — a dependency/affinity edge between two blocks. */
export const MapRoadSchema = z.object({
  a: z.string(),
  b: z.string(),
  affinity: z.number(),
  source: z.enum(['import', 'embedding', 'mixed']),
  bidirectional: z.boolean(),
});
export type MapRoad = z.infer<typeof MapRoadSchema>;

export const MapPrChangeSchema = z.object({
  blockId: z.string(),
  change: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  fromPath: z.string().optional(),
});
export type MapPrChange = z.infer<typeof MapPrChangeSchema>;
export const MapPrOverlaySchema = z.object({
  prNumber: z.number().int().optional(),
  title: z.string().optional(),
  changedBlocks: z.array(MapPrChangeSchema),
});
export type MapPrOverlay = z.infer<typeof MapPrOverlaySchema>;

/** Map-level parameters of the urbanity field, so the renderer can do ambient
 *  effects (haze toward downtown, traffic falloff) without re-deriving policy. */
export const MapUrbanitySchema = z.object({
  /** Importance-weighted downtown centroid, world coords. */
  center: z.object({ x: z.number(), y: z.number() }),
  /** Weighted radius of gyration — the falloff scale of the field. */
  radius: z.number().positive(),
  /** Project-size cap multiplied into every block's urbanity: a small repo is
   *  uniformly rural but keeps its internal contrast shape. */
  ceiling: z.number().min(0).max(1),
  peak: z.number().min(0).max(1),
  median: z.number().min(0).max(1),
  /** The settlement's overall register, bucketed from `peak`. */
  settlement: SettlementSchema,
  /** Live blocks the field was computed over. */
  fileCount: z.number().int().nonnegative(),
});
export type MapUrbanity = z.infer<typeof MapUrbanitySchema>;

/**
 * Which slice of a code project to map. `core` is the default and excludes test
 * files (they're large, symbol-less, and drown out the real code); `tests` maps
 * only the test files as their own separate "city"; `all` places those two
 * stable cities beside each other without re-laying out either one. JSON/data
 * files are always excluded from code maps regardless of scope.
 */
export const FileMapScopeSchema = z.enum(['core', 'tests', 'all']);
export type FileMapScope = z.infer<typeof FileMapScopeSchema>;

export const FileMapRequestSchema = z.object({
  domain: z.enum(['code', 'docs', 'data']).optional(),
  scope: FileMapScopeSchema.optional(),
  /** When set, overlay this pull request's changed files onto the map. */
  pr: z.number().int().positive().optional(),
});
export type FileMapRequest = z.infer<typeof FileMapRequestSchema>;

export const FileMapResponseSchema = z.object({
  domain: z.string(),
  root: z.string(),
  bounds: RectSchema,
  builtAt: z.string(),
  /** false when the index hasn't been built yet (everything else may be empty). */
  indexed: z.boolean(),
  districts: z.array(MapDistrictSchema),
  blocks: z.array(MapBlockSchema),
  buildings: z.array(MapBuildingSchema),
  roads: z.array(MapRoadSchema),
  /** Paved streets between folders/rows (absent on pre-street layouts). */
  streets: z.array(MapStreetSchema).optional(),
  /** Plazas and greens (absent on pre-v5 layouts). */
  plazas: z.array(MapPlazaSchema).optional(),
  overlay: MapPrOverlaySchema.optional(),
  /** Urbanity-field parameters (absent on pre-V6 layouts). */
  urbanity: MapUrbanitySchema.optional(),
  /** Signal provenance for lenses/legends. */
  signals: z
    .object({
      gitAvailable: z.boolean(),
      churnWindowDays: z.number().int().positive(),
    })
    .optional(),
});
export type FileMapResponse = z.infer<typeof FileMapResponseSchema>;
