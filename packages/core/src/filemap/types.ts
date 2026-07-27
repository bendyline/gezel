import type { MapDistrict, MapPlaza, MapStreet, Rect } from '../schemas/api.js';
import type { VillageAnchor, VillageOverride } from '../schemas/village-file.js';

/**
 * Pure-layout I/O for the city-map engine. The engine knows nothing about files,
 * imports, or rendering — only weighted hierarchical nodes (paths), affinity
 * edges between them, and their prior persisted coordinates. That is what lets
 * the same engine lay out code, docs, and data folder trees unchanged.
 */

/** One live node to place: a file path, its weight (LoC) and content hash. */
export interface LayoutFileInput {
  path: string;
  weight: number;
  contentHash: string | null;
  /** Import-graph centrality [0,1] — widens yards (roomier hub lots). */
  importance?: number;
  /** Skyline landmark — the seed reserves an adjacent plaza. */
  landmark?: boolean;
}

/** An affinity edge between two file paths (higher = pull closer / seed near). */
export interface AffinityEdge {
  a: string;
  b: string;
  weight: number;
}

/** A previously-persisted coordinate (district/block/street/plate/plaza),
 *  incl. tombstones. */
export interface PriorNode {
  nodeKind: 'district' | 'block' | 'street' | 'plate' | 'plaza';
  nodeId: string;
  /** For streets this is the interior folder ('' persisted as null). */
  parentId?: string | null;
  rect: Rect;
  contentHash: string | null;
  /** For streets the tier rides in this column. */
  weight: number;
  placedAt: string | null;
  removedAt: string | null;
}

export interface LayoutOptions {
  /** World extent the first build seeds into (default 1000×1000). */
  width?: number;
  height?: number;
  /** Timestamp stamped onto newly-placed / tombstoned nodes (engine is pure). */
  nowIso: string;
  /** Tombstones removed strictly before this ISO time are pruned (gentle GC). */
  tombstoneCutoffIso?: string;
  /** Macro placement memory: seeds honor these compass regions for top-level
   *  display districts (recorded to the city file at first seed). */
  anchors?: VillageAnchor[];
  /** User pins from the city file (region/rect for top-level folders). */
  overrides?: VillageOverride[];
  /** @deprecated pre-street block gap; kept for placeGhostBlocks callers. */
  gap?: number;
}

/** Where a block ended up, and how it should read on the map. */
export interface BlockPlacement {
  /** The parcel: persistence + collision unit, frozen across builds. */
  lot: Rect;
  /** The building: derived from current LoC each build, clamped inside the lot. */
  footprint: Rect;
  state: 'live' | 'new' | 'tombstoned';
  placedAt: string | null;
}

/** A row to persist back into `map_layout` (mirrors the store's LayoutRow). */
export interface PersistNode {
  nodeKind: 'district' | 'block' | 'street' | 'plate' | 'plaza';
  nodeId: string;
  parentId: string | null;
  contentHash: string | null;
  /** Blocks persist their LOT (not the footprint); streets their pavement rect. */
  rect: Rect;
  /** Blocks: LoC. Streets: tier (documented reuse of the column). */
  weight: number;
  placedAt: string | null;
  removedAt: string | null;
}

export interface LayoutResult {
  /** path → placement, including tombstoned (gone) blocks kept as rubble. */
  blocks: Map<string, BlockPlacement>;
  /** one per folder prefix that contains ≥1 block (live or tombstoned). */
  districts: MapDistrict[];
  /** paved streets between folders/rows, stable across builds. */
  streets: MapStreet[];
  /** plazas (fronting landmarks) + greens (leftover packing space). */
  plazas: MapPlaza[];
  /** compass anchors recorded by a seed build ([] on incremental builds —
   *  the service keeps the city file's existing anchors then). */
  anchors: VillageAnchor[];
  /** the authoritative layout to write back to the store. */
  persist: PersistNode[];
}
