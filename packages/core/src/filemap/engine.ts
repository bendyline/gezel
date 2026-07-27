import type { MapBuilding, MapDistrict, MapPlaza, MapStreet, Rect } from '../schemas/api.js';
import type { VillageAnchor } from '../schemas/village-file.js';
import {
  SIDEWALK,
  appendLotInFolder,
  blockSize,
  footprintWithin,
  hash01,
  lotSpec,
} from './lots.js';
import { displayLabels } from './plates.js';
import { type StreetSeg, streetTier, streetWidth, toMapStreet } from './streets.js';
import { type TownPlate, type TownPlaza, packTownRoot, packTownSubtree } from './town.js';
import type {
  AffinityEdge,
  BlockPlacement,
  LayoutFileInput,
  LayoutOptions,
  LayoutResult,
  PersistNode,
  PriorNode,
} from './types.js';

/**
 * Stable city layout. Files are parcels ("lots") holding a building footprint;
 * folders are city blocks separated by tiered streets (avenue → alley by
 * depth); the whole map is seeded once by the v5 "planned town" packer
 * (compass macro grid + column/ladder packing, see town.ts) and then only
 * ever grows. Existing lots never move: new files spiral into free space near
 * their import neighbours; deletes become tombstones ("rubble") pruned after a
 * cutoff; renames transplant a lot by content hash. Label plates and plazas
 * are first-class persisted geometry — frozen like lots, never built on.
 * Districts are padded bounding boxes of their blocks, so they always enclose
 * their (stable) blocks.
 */

const DEFAULT_W = 1000;
const DEFAULT_H = 1000;
const DEFAULT_GAP = 3;

interface Point {
  x: number;
  y: number;
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

function center(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function offsetRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

/** A small deterministic position from a path (fallback when there's no signal). */
function hashPoint(path: string, w: number, h: number): Point {
  let a = 2166136261;
  for (let i = 0; i < path.length; i++) {
    a ^= path.charCodeAt(i);
    a = Math.imul(a, 16777619);
  }
  const ux = ((a >>> 0) % 10000) / 10000;
  const uy = (((a >>> 8) >>> 0) % 10000) / 10000;
  return { x: ux * w, y: uy * h };
}

// ── seeding (delegates to the v5 town packer) ───────────────────────────────

interface SeededLayout {
  lots: Map<string, { lot: Rect; foot: Rect }>;
  streets: StreetSeg[];
  plates: TownPlate[];
  plazas: TownPlaza[];
  anchors: VillageAnchor[];
}

/** Deterministic, non-overlapping seed for the whole city. */
function seedLayout(files: LayoutFileInput[], options: LayoutOptions): SeededLayout {
  return packTownRoot(files, {
    anchors: options.anchors ?? [],
    overrides: options.overrides ?? [],
    nowIso: options.nowIso,
  });
}

/**
 * Pack a wholly-new folder's files in isolation and drop the whole box into
 * free space near `seed` — a new folder arrives as one cohesive city block
 * with its own internal lanes, plate, and plazas, instead of scattering file
 * by file.
 */
function placeNewSubtree(
  groupFiles: LayoutFileInput[],
  folderDepth: number,
  seed: Point,
  occupied: Rect[],
): Omit<SeededLayout, 'anchors'> {
  const packed = packTownSubtree(groupFiles, folderDepth);
  const clearance = streetWidth(Math.max(0, folderDepth - 1));
  const box = nearestFreeRect(seed, packed.w, packed.h, occupied, clearance);
  const lots = new Map<string, { lot: Rect; foot: Rect }>();
  for (const [path, cell] of packed.lots) {
    lots.set(path, {
      lot: offsetRect(cell.lot, box.x, box.y),
      foot: offsetRect(cell.foot, box.x, box.y),
    });
  }
  return {
    lots,
    streets: packed.streets.map((st) => ({ ...st, rect: offsetRect(st.rect, box.x, box.y) })),
    plates: packed.plates.map((p) => ({ ...p, rect: offsetRect(p.rect, box.x, box.y) })),
    plazas: packed.plazas.map((p) => ({ ...p, rect: offsetRect(p.rect, box.x, box.y) })),
  };
}

// ── collision-avoided placement (incremental new files) ─────────────────────

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
  );
}

function rectAt(p: Point, w: number, h: number): Rect {
  return { x: p.x - w / 2, y: p.y - h / 2, w, h };
}

/**
 * Find the nearest position to `seed` where a `w`×`h` rect doesn't collide
 * with any occupied rect — a coarse outward spiral. Falls back to the seed
 * itself (allowing overlap) after a bounded search.
 */
export function nearestFreeRect(
  seed: Point,
  w: number,
  h: number,
  occupied: Rect[],
  gap: number,
): Rect {
  const step = Math.max(w, h) + gap;
  const seedRect = rectAt(seed, w, h);
  if (!occupied.some((o) => overlaps(seedRect, o, gap))) return seedRect;
  for (let ring = 1; ring <= 120; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // ring border only
        const r = rectAt({ x: seed.x + dx * step, y: seed.y + dy * step }, w, h);
        if (!occupied.some((o) => overlaps(r, o, gap))) return r;
      }
    }
  }
  return seedRect;
}

function nearestFreeSlot(seed: Point, size: number, occupied: Rect[], gap: number): Rect {
  return nearestFreeRect(seed, size, size, occupied, gap);
}

/**
 * Place transient "ghost" blocks (e.g. PR-added files not yet in the index)
 * into the free space of an already-laid-out map without overlapping existing
 * blocks or each other. Each ghost is seeded near a point (its district) and
 * collision-avoided. Pure + deterministic (placed in id order). Not persisted —
 * this is an overlay-time helper, so it doesn't disturb the stable layout.
 */
export function placeGhostBlocks(
  occupied: Rect[],
  ghosts: Array<{ id: string; size: number; seedX: number; seedY: number }>,
  gap: number = DEFAULT_GAP,
): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const occ = occupied.slice();
  for (const g of [...ghosts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const rect = nearestFreeSlot({ x: g.seedX, y: g.seedY }, g.size, occ, gap);
    occ.push(rect);
    out.set(g.id, rect);
  }
  return out;
}

// ── districts (padded bbox per folder) ──────────────────────────────────────

/** District edge padding: just inside the surrounding street so curbs read. */
function districtPad(depth: number): number {
  return depth <= 1 ? 6 : 4;
}

function buildDistricts(
  blocks: Map<string, BlockPlacement>,
  weightByPath: Map<string, number>,
  liveSet: Set<string>,
  displayByFolder: Map<string, string>,
  plateByFolder: Map<string, Rect>,
): MapDistrict[] {
  // Accumulate a bbox + tallies for every folder prefix that holds a block.
  interface Acc {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    weight: number;
    fileCount: number;
  }
  const acc = new Map<string, Acc>();
  const bump = (folder: string, r: Rect, path: string) => {
    let a = acc.get(folder);
    if (!a) {
      a = {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
        weight: 0,
        fileCount: 0,
      };
      acc.set(folder, a);
    }
    a.minX = Math.min(a.minX, r.x);
    a.minY = Math.min(a.minY, r.y);
    a.maxX = Math.max(a.maxX, r.x + r.w);
    a.maxY = Math.max(a.maxY, r.y + r.h);
    a.weight += weightByPath.get(path) ?? 0;
    if (liveSet.has(path)) a.fileCount += 1;
  };
  for (const [path, pl] of blocks) {
    // every ancestor folder gets this block's LOT in its bbox (yards included)
    const segs = path.split('/');
    for (let i = 1; i < segs.length; i++) {
      bump(segs.slice(0, i).join('/'), pl.lot, path);
    }
  }
  // a district's plate always sits inside its bbox, even before blocks grow
  for (const [folder, plate] of plateByFolder) {
    const a = acc.get(folder);
    if (!a) continue;
    a.minX = Math.min(a.minX, plate.x);
    a.minY = Math.min(a.minY, plate.y);
    a.maxX = Math.max(a.maxX, plate.x + plate.w);
    a.maxY = Math.max(a.maxY, plate.y + plate.h);
  }
  const out: MapDistrict[] = [];
  for (const [folder, a] of acc) {
    if (a.fileCount === 0) continue; // folder of only-tombstoned files: skip label
    const depth = folder.split('/').length;
    const pad = districtPad(depth);
    const displayLabel = displayByFolder.get(folder);
    const plate = plateByFolder.get(folder);
    out.push({
      id: folder,
      parentId: folder.includes('/') ? folderOf(folder) : null,
      rect: {
        x: a.minX - pad,
        y: a.minY - pad,
        w: a.maxX - a.minX + pad * 2,
        h: a.maxY - a.minY + pad * 2,
      },
      label: basename(folder),
      depth,
      fileCount: a.fileCount,
      weight: a.weight,
      ...(displayLabel !== undefined ? { displayLabel } : {}),
      ...(plate ? { labelPlate: plate } : {}),
    });
  }
  // outer districts first so the renderer can paint parents under children
  out.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
  return out;
}

// ── the engine ──────────────────────────────────────────────────────────────

/** Every folder prefix (plus the root '') that still holds any block. */
function foldersWithBlocks(placements: Map<string, BlockPlacement>): Set<string> {
  const set = new Set<string>();
  if (placements.size > 0) set.add('');
  for (const path of placements.keys()) {
    const segs = path.split('/');
    for (let i = 1; i < segs.length; i++) set.add(segs.slice(0, i).join('/'));
  }
  return set;
}

function priorStreetToMapStreet(p: PriorNode): MapStreet {
  return {
    id: p.nodeId,
    rect: p.rect,
    tier: streetTier(Math.round(p.weight)),
    districtId: p.parentId ?? null,
  };
}

function townPlazaToMapPlaza(p: TownPlaza): MapPlaza {
  return {
    id: p.id,
    districtId: p.folder === '' ? null : p.folder,
    rect: p.rect,
    kind: p.kind,
    ...(p.blockId !== undefined ? { blockId: p.blockId } : {}),
  };
}

function priorPlazaToMapPlaza(p: PriorNode): MapPlaza {
  const isPlaza = p.nodeId.startsWith('plaza:');
  return {
    id: p.nodeId,
    districtId: p.parentId ?? null,
    rect: p.rect,
    kind: isPlaza ? 'plaza' : 'green',
    ...(isPlaza ? { blockId: p.nodeId.slice('plaza:'.length) } : {}),
  };
}

export function layoutFileMap(
  files: LayoutFileInput[],
  edges: AffinityEdge[],
  prior: PriorNode[],
  options: LayoutOptions,
): LayoutResult {
  const W = options.width ?? DEFAULT_W;
  const H = options.height ?? DEFAULT_H;
  const now = options.nowIso;

  const priorBlocks = new Map<string, PriorNode>();
  const priorStreets: PriorNode[] = [];
  const priorPlates: PriorNode[] = [];
  const priorPlazas: PriorNode[] = [];
  // Derived nodes (streets, plates, plazas, districts) keep their original
  // first-seen timestamp instead of restamping `now` every build. Restamping
  // rewrites the journal on every rebuild, which puts a dirty diff in
  // `.gezel/village.json` — a file we explicitly ask users to commit — even when
  // nothing about the settlement changed.
  const priorPlacedAt = new Map<string, string>();
  for (const p of prior) {
    if (p.placedAt) priorPlacedAt.set(`${p.nodeKind}:${p.nodeId}`, p.placedAt);
    if (p.nodeKind === 'block') priorBlocks.set(p.nodeId, p);
    else if (p.nodeKind === 'street') priorStreets.push(p);
    else if (p.nodeKind === 'plate') priorPlates.push(p);
    else if (p.nodeKind === 'plaza') priorPlazas.push(p);
  }
  const placedAtFor = (kind: string, id: string): string =>
    priorPlacedAt.get(`${kind}:${id}`) ?? now;

  const liveByPath = new Map(files.map((f) => [f.path, f] as const));
  const liveSet = new Set(liveByPath.keys());
  const weightByPath = new Map<string, number>();
  for (const f of files) weightByPath.set(f.path, Math.max(1, f.weight));
  for (const [path, p] of priorBlocks) {
    if (!liveSet.has(path)) weightByPath.set(path, p.weight || 1);
  }

  const placements = new Map<string, BlockPlacement>();
  let streets: MapStreet[];
  let plates: TownPlate[];
  let plazas: MapPlaza[];
  let anchors: VillageAnchor[] = [];

  if (priorBlocks.size === 0) {
    // FIRST BUILD: the town packer sizes every box to fit, so the seed is
    // non-overlapping by construction — no collision pass needed.
    const seeded = seedLayout(files, options);
    for (const f of files) {
      const cell = seeded.lots.get(f.path);
      if (cell) {
        placements.set(f.path, {
          lot: cell.lot,
          footprint: cell.foot,
          state: 'new',
          placedAt: now,
        });
      } else {
        const s = blockSize(f.weight);
        const lot = { x: 0, y: 0, w: s, h: s };
        placements.set(f.path, {
          lot,
          footprint: footprintWithin(f.path, f.weight, lot),
          state: 'new',
          placedAt: now,
        });
      }
    }
    streets = seeded.streets.map(toMapStreet);
    plates = seeded.plates;
    plazas = seeded.plazas.map(townPlazaToMapPlaza);
    anchors = seeded.anchors;
  } else {
    // INCREMENTAL: keep existing lots put; place only new files.
    const consumed = new Set<string>();
    const goneByHash = new Map<string, PriorNode[]>();
    for (const [path, p] of priorBlocks) {
      if (!liveSet.has(path) && p.contentHash) {
        const arr = goneByHash.get(p.contentHash) ?? [];
        arr.push(p);
        goneByHash.set(p.contentHash, arr);
      }
    }

    const newFiles: LayoutFileInput[] = [];
    for (const f of files) {
      const pr = priorBlocks.get(f.path);
      if (pr) {
        // existing path: the lot is frozen; the footprint regrows inside it
        placements.set(f.path, {
          lot: pr.rect,
          footprint: footprintWithin(f.path, f.weight, pr.rect),
          state: 'live',
          placedAt: pr.placedAt ?? now,
        });
        continue;
      }
      // new path: rename-by-hash transplant (only when unambiguous)
      let transplant: PriorNode | undefined;
      if (f.contentHash) {
        const cands = (goneByHash.get(f.contentHash) ?? []).filter((c) => !consumed.has(c.nodeId));
        if (cands.length === 1) transplant = cands[0];
      }
      if (transplant) {
        consumed.add(transplant.nodeId);
        placements.set(f.path, {
          lot: transplant.rect,
          footprint: footprintWithin(f.path, f.weight, transplant.rect),
          state: 'new',
          placedAt: now,
        });
      } else {
        newFiles.push(f);
      }
    }

    // vacant-lot inventory (cutoff-filtered tombstones, claimable by new files)
    const tombstones = new Map<string, PriorNode>();
    for (const [path, p] of priorBlocks) {
      if (liveSet.has(path) || consumed.has(p.nodeId)) continue;
      const removedAt = p.removedAt ?? now;
      if (options.tombstoneCutoffIso && removedAt < options.tombstoneCutoffIso) continue; // pruned
      tombstones.set(path, p);
    }

    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      (adjacency.get(e.a) ?? adjacency.set(e.a, []).get(e.a)!).push(e.b);
      (adjacency.get(e.b) ?? adjacency.set(e.b, []).get(e.b)!).push(e.a);
    }
    const centroid = (pts: Point[]): Point => ({
      x: pts.reduce((s2, p) => s2 + p.x, 0) / pts.length,
      y: pts.reduce((s2, p) => s2 + p.y, 0) / pts.length,
    });
    const neighborPoints = (path: string): Point[] =>
      (adjacency.get(path) ?? [])
        .map((n) => placements.get(n))
        .filter((p): p is BlockPlacement => !!p)
        .map((p) => center(p.lot));

    // never build on an existing lot, a vacant lot, a street, a plate, or a plaza
    const occupied = [...placements.values()].map((p) => p.lot);
    for (const t of tombstones.values()) occupied.push(t.rect);
    for (const st of priorStreets) occupied.push(st.rect);
    for (const pl of priorPlates) occupied.push(pl.rect);
    for (const pz of priorPlazas) occupied.push(pz.rect);
    const newStreetSegs: StreetSeg[] = [];
    const newPlates: TownPlate[] = [];
    const newPlazas: TownPlaza[] = [];

    // deterministic order: by path
    newFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // Split the arrivals: files under a wholly-new folder land together as one
    // cohesive city block; files joining an existing folder are placed one by one.
    const priorFolders = new Set<string>();
    for (const path of priorBlocks.keys()) {
      const segs = path.split('/');
      for (let i = 1; i < segs.length; i++) priorFolders.add(segs.slice(0, i).join('/'));
    }
    const groups = new Map<string, LayoutFileInput[]>();
    const singles: LayoutFileInput[] = [];
    for (const f of newFiles) {
      const segs = f.path.split('/');
      let groupKey: string | null = null;
      for (let i = 1; i < segs.length; i++) {
        const folder = segs.slice(0, i).join('/');
        if (!priorFolders.has(folder)) {
          groupKey = folder;
          break;
        }
      }
      if (groupKey) {
        const arr = groups.get(groupKey);
        if (arr) arr.push(f);
        else groups.set(groupKey, [f]);
      } else {
        singles.push(f);
      }
    }

    for (const [folder, groupFiles] of [...groups.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : 1,
    )) {
      const nPts = groupFiles.flatMap((f) => neighborPoints(f.path));
      let seed: Point;
      if (nPts.length) {
        seed = centroid(nPts);
      } else {
        // near the closest existing ancestor's blocks, else a hash point
        let anc = folderOf(folder);
        let pts: Point[] = [];
        while (anc && pts.length === 0) {
          const prefix = `${anc}/`;
          pts = [...placements.entries()]
            .filter(([path]) => path.startsWith(prefix))
            .map(([, pl]) => center(pl.lot));
          anc = folderOf(anc);
        }
        seed = pts.length ? centroid(pts) : hashPoint(folder, W, H);
      }
      const sub = placeNewSubtree(groupFiles, folder.split('/').length, seed, occupied);
      for (const [path, cell] of sub.lots) {
        placements.set(path, {
          lot: cell.lot,
          footprint: cell.foot,
          state: 'new',
          placedAt: now,
        });
        occupied.push(cell.lot);
      }
      for (const st of sub.streets) {
        newStreetSegs.push(st);
        occupied.push(st.rect);
      }
      for (const pl of sub.plates) {
        newPlates.push(pl);
        occupied.push(pl.rect);
      }
      for (const pz of sub.plazas) {
        newPlazas.push(pz);
        occupied.push(pz.rect);
      }
    }

    const freshCells: SeededLayout['lots'] = singles.length
      ? seedLayout(files, options).lots
      : new Map();
    for (const f of singles) {
      const spec = lotSpec(f.path, f.weight, f.importance ?? 0);
      const folder = folderOf(f.path);

      // 1) claim a vacant sibling lot of a workable size (smallest first)
      let claimed: string | null = null;
      let claimedArea = Number.POSITIVE_INFINITY;
      const specArea = spec.lotW * spec.lotH;
      for (const [tp, t] of tombstones) {
        if (folderOf(tp) !== folder) continue;
        const area = t.rect.w * t.rect.h;
        if (area < specArea * 0.8 || area > specArea * 2) continue;
        if (area < claimedArea || (area === claimedArea && (claimed === null || tp < claimed))) {
          claimed = tp;
          claimedArea = area;
        }
      }
      if (claimed) {
        const lot = tombstones.get(claimed)!.rect;
        tombstones.delete(claimed);
        placements.set(f.path, {
          lot,
          footprint: footprintWithin(f.path, f.weight, lot),
          state: 'new',
          placedAt: now,
        });
        continue; // the claimed lot is already in `occupied`
      }

      // 2) extend the folder's strip: end of the bottom row, or a new row
      const siblingLots: Rect[] = [];
      for (const [path, pl] of placements) {
        if (folderOf(path) === folder) siblingLots.push(pl.lot);
      }
      for (const [tp, t] of tombstones) {
        if (folderOf(tp) === folder) siblingLots.push(t.rect);
      }
      const appended = appendLotInFolder(spec, siblingLots, occupied);
      if (appended) {
        placements.set(f.path, {
          lot: appended.lot,
          footprint: footprintWithin(f.path, f.weight, appended.lot),
          state: 'new',
          placedAt: now,
        });
        occupied.push(appended.lot);
        if (appended.newLane) {
          newStreetSegs.push({ rect: appended.newLane, tier: 3, folder });
          occupied.push(appended.newLane);
        }
        continue;
      }

      // 3) fall back to the spiral, seeded by imports / a fresh pack / a hash
      const nPts = neighborPoints(f.path);
      let seed: Point;
      if (nPts.length) {
        seed = centroid(nPts);
      } else {
        const cell = freshCells.get(f.path);
        seed = cell ? center(cell.lot) : hashPoint(f.path, W, H);
      }
      const lot = nearestFreeRect(seed, spec.lotW, spec.lotH, occupied, SIDEWALK);
      occupied.push(lot);
      placements.set(f.path, {
        lot,
        footprint: footprintWithin(f.path, f.weight, lot),
        state: 'new',
        placedAt: now,
      });
    }

    // unclaimed vacant lots stay on the map as rubble
    for (const [path, p] of tombstones) {
      placements.set(path, {
        lot: p.rect,
        footprint: footprintWithin(path, weightByPath.get(path) ?? p.weight, p.rect),
        state: 'tombstoned',
        placedAt: p.placedAt,
      });
    }

    // streets/plates/plazas pass through verbatim (plus fresh ones); drop the
    // ones whose folder is fully gone
    const activeFolders = foldersWithBlocks(placements);
    streets = [
      ...priorStreets
        .filter((p) => activeFolders.has(p.parentId ?? ''))
        .map(priorStreetToMapStreet),
      ...newStreetSegs.map(toMapStreet),
    ];
    plates = [
      ...priorPlates
        .filter((p) => activeFolders.has(p.nodeId))
        .map((p) => ({ folder: p.nodeId, rect: p.rect })),
      ...newPlates,
    ];
    plazas = [
      ...priorPlazas.filter((p) => activeFolders.has(p.parentId ?? '')).map(priorPlazaToMapPlaza),
      ...newPlazas.map(townPlazaToMapPlaza),
    ];
  }

  const plateByFolder = new Map(plates.map((p) => [p.folder, p.rect] as const));
  const districts = buildDistricts(
    placements,
    weightByPath,
    liveSet,
    displayLabels(files),
    plateByFolder,
  );

  // authoritative rows to persist
  const persist: PersistNode[] = [];
  for (const [path, pl] of placements) {
    const f = liveByPath.get(path);
    const prevHash = priorBlocks.get(path)?.contentHash ?? null;
    persist.push({
      nodeKind: 'block',
      nodeId: path,
      parentId: folderOf(path) || null,
      contentHash: f?.contentHash ?? prevHash,
      rect: pl.lot,
      weight: weightByPath.get(path) ?? 0,
      placedAt: pl.placedAt,
      removedAt: pl.state === 'tombstoned' ? (priorBlocks.get(path)?.removedAt ?? now) : null,
    });
  }
  for (const d of districts) {
    persist.push({
      nodeKind: 'district',
      nodeId: d.id,
      parentId: d.parentId,
      contentHash: null,
      rect: d.rect,
      weight: d.weight,
      placedAt: placedAtFor('district', d.id),
      removedAt: null,
    });
  }
  for (const st of streets) {
    persist.push({
      nodeKind: 'street',
      nodeId: st.id,
      parentId: st.districtId,
      contentHash: null,
      rect: st.rect,
      weight: st.tier,
      placedAt: placedAtFor('street', st.id),
      removedAt: null,
    });
  }
  for (const p of plates) {
    persist.push({
      nodeKind: 'plate',
      nodeId: p.folder,
      parentId: folderOf(p.folder) || null,
      contentHash: null,
      rect: p.rect,
      weight: 0,
      placedAt: placedAtFor('plate', p.folder),
      removedAt: null,
    });
  }
  for (const p of plazas) {
    persist.push({
      nodeKind: 'plaza',
      nodeId: p.id,
      parentId: p.districtId,
      contentHash: null,
      rect: p.rect,
      weight: 0,
      placedAt: placedAtFor('plaza', p.id),
      removedAt: null,
    });
  }

  return { blocks: placements, districts, streets, plazas, anchors, persist };
}

// ── buildings (symbols inside a block) — deterministic, not persisted ────────

/** Spans at/below this sit on the height floor (a trivial accessor). */
const SPAN_BASE = 4;
/** Spans at/above this hit height 1.0 (a monster function/class). */
const SPAN_FULL = 400;
/** Every building keeps this much wire height — nothing renders as a slab. */
const HEIGHT_FLOOR = 0.12;
/** Minimum grid cell (world units) so buildings never shrink to slivers;
 *  crowded blocks drop their smallest symbols instead. */
const MIN_CELL = 3.2;
/** Footprint fill of the cell: small symbols are sheds, big ones fill it. */
const FILL_MIN = 0.5;
const FILL_MAX = 0.88;

/** Log-normalized symbol size in [0, 1] — ABSOLUTE, not relative to the file,
 *  so a 40-line function reads the same height anywhere on the map. */
export function symbolSizeT(lineSpan: number): number {
  const span = Math.max(1, lineSpan);
  const t = Math.log(Math.max(1, span / SPAN_BASE)) / Math.log(SPAN_FULL / SPAN_BASE);
  return Math.min(1, t);
}

/**
 * Lay symbols out as a small grid of buildings inside a block, in source order
 * (top-to-bottom = file order). Height and footprint follow the symbol's line
 * span on the absolute `symbolSizeT` scale, bounded on both ends: a floor so
 * every building stays visible, a cap so one giant can't flatten the rest.
 * When a block can't host every symbol at `MIN_CELL`, the largest symbols win
 * the ground (still placed in source order); `MapBlock.buildingCount` keeps
 * reporting the true total.
 */
export function layoutBuildingsInBlock(
  blockId: string,
  blockRect: Rect,
  symbols: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }>,
): MapBuilding[] {
  if (symbols.length === 0) return [];
  const span = (s: { lineStart: number; lineEnd: number }): number =>
    Math.max(1, s.lineEnd - s.lineStart + 1);
  const ordered = [...symbols].sort((a, b) => a.lineStart - b.lineStart);

  const pad = Math.min(blockRect.w, blockRect.h) * 0.12;
  const innerW = Math.max(1, blockRect.w - pad * 2);
  const innerH = Math.max(1, blockRect.h - pad * 2);
  const colsMax = Math.max(1, Math.floor(innerW / MIN_CELL));
  const rowsMax = Math.max(1, Math.floor(innerH / MIN_CELL));

  let placed = ordered;
  const capacity = colsMax * rowsMax;
  if (ordered.length > capacity) {
    const keep = new Set([...ordered].sort((a, b) => span(b) - span(a)).slice(0, capacity));
    placed = ordered.filter((s) => keep.has(s));
  }

  const cols = Math.min(
    colsMax,
    Math.max(Math.ceil(Math.sqrt(placed.length)), Math.ceil(placed.length / rowsMax)),
  );
  const rows = Math.ceil(placed.length / cols);
  const cw = innerW / cols;
  const ch = innerH / rows;

  return placed.map((s, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const id = `${blockId}#${s.name}`;
    const t = symbolSizeT(span(s));
    const fill = FILL_MIN + (FILL_MAX - FILL_MIN) * t;
    const aspect = 0.88 + 0.26 * hash01(id, 7);
    const fw = Math.min(cw * 0.92, cw * fill * aspect);
    const fh = Math.min(ch * 0.92, (ch * fill) / aspect);
    return {
      id,
      blockId,
      rect: {
        x: blockRect.x + pad + col * cw + (cw - fw) / 2,
        y: blockRect.y + pad + row * ch + (ch - fh) / 2,
        w: fw,
        h: fh,
      },
      height: HEIGHT_FLOOR + (1 - HEIGHT_FLOOR) * t,
      lines: span(s),
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
      label: s.name,
      kind: s.kind,
    };
  });
}
