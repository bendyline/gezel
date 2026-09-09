import type { FileMapResponse, MapBlock, MapBuilding } from '@bendyline/gezel';
import type { Camera } from '../camera.js';
import { hasSymbolCampus } from '../file-use.js';
import { styleForModel } from '../town-cache.js';
import { depthOrder } from './depth.js';
import {
  HZ,
  PODIUM_HISO,
  heightOf,
  hitsPrism,
  isoAabb,
  miniHIso,
  townRoofRiseIso,
} from './projection.js';
import { type TownStyle, townStyleForSymbol } from './town-style.js';

/**
 * Per-model iso geometry: prism heights, iso AABBs, and the memoized painter
 * order. Computed once per payload (WeakMap, same pattern as decorForModel) —
 * per-frame work is culling and drawing only.
 */

export interface BlockGeom {
  campus?: Array<{ building: MapBuilding; roofFactor: number }>;
  block: MapBlock;
  /** World height of the prism (0 = flat: tombstones and city-tier lots). */
  hWorld: number;
  /** Iso height (world height × HZ). */
  hIso: number;
  /** Iso-plane AABB including height (culling + fit). */
  aabb: { u0: number; u1: number; v0: number; v1: number };
  /** Resolved architecture, from the shared per-model cache. Absent on
   *  tombstones, which draw as rubble and have no building. */
  style?: TownStyle;
  /**
   * Multiplier on the roof headroom above the prism. `townRoofRiseIso` is the
   * budget culling, hit-testing, and the issue-marker anchor all assume; a
   * clock tower or kiln cone reaching past it would pop in on scroll and leave
   * a dead click zone over its own silhouette. Anything that draws taller than
   * an ordinary roof declares itself here instead.
   */
  roofFactor: number;
}

export interface GeometryCache {
  geoms: BlockGeom[];
  /** Back-to-front indices into `geoms`. */
  order: number[];
  /** Tallest prism's iso height (fit headroom). */
  maxHIso: number;
}

/** Storeys for a block: server-computed levels, or a legacy-payload fallback. */
export function levelsFor(b: MapBlock): number {
  if (b.levels !== undefined) return b.levels;
  return Math.max(1, Math.min(5, 1 + Math.round(Math.sqrt(Math.max(1, b.weight)) / 15)));
}

function buildGeometry(model: FileMapResponse): GeometryCache {
  const styles = styleForModel(model);
  const geoms: BlockGeom[] = model.blocks.map((block) => {
    const style = styles.get(block.id);
    // A field and a park have no walls; their features live in the roof
    // headroom their archetype declares, so hit-testing still covers them.
    const flat =
      block.state === 'tombstoned' || style?.archetype === 'field' || style?.archetype === 'park';
    const hWorld = flat ? 0 : heightOf(levelsFor(block));
    const hIso = hWorld * HZ;
    const campus =
      block.state === 'live' && !block.phantom && hasSymbolCampus(block)
        ? buildingsForBlock(model, block.id).map((building) => ({
            building,
            roofFactor: townStyleForSymbol(building, block).roofFactor ?? 1,
          }))
        : [];
    return {
      ...(campus.length ? { campus } : {}),
      block,
      hWorld,
      hIso,
      aabb: isoAabb(block.rect, hIso),
      ...(style ? { style } : {}),
      roofFactor: style?.roofFactor ?? 1,
    };
  });
  const order = depthOrder(
    geoms.map((g) => ({ rect: g.block.rect, u0: g.aabb.u0, u1: g.aabb.u1 })),
  );
  let maxHIso = 0;
  for (const g of geoms) {
    maxHIso = Math.max(maxHIso, g.hIso);
    for (const mini of g.campus ?? [])
      maxHIso = Math.max(maxHIso, PODIUM_HISO + miniHIso(mini.building.height));
  }
  return { geoms, order, maxHIso };
}

const cache = new WeakMap<FileMapResponse, GeometryCache>();

export function geometryForModel(model: FileMapResponse): GeometryCache {
  const hit = cache.get(model);
  if (hit) return hit;
  const built = buildGeometry(model);
  cache.set(model, built);
  return built;
}

/** Roof headroom above a block's prism, including whatever its architecture
 *  declares it needs. The single definition all three consumers share. */
export function roofHeadroom(g: BlockGeom, scale: number): number {
  if (g.block.state !== 'live' || g.block.phantom) return 0;
  return townRoofRiseIso(g.block.rect, scale) * g.roofFactor;
}

/** True when a geom's projected box intersects the viewport. */
export function geomInView(cam: Camera, g: BlockGeom, viewW: number, viewH: number): boolean {
  let roof = roofHeadroom(g, cam.scale);
  // A small file can contain a tall symbol. Budget its actual silhouette,
  // otherwise the courtyard disappears while its upper floors are visible.
  for (const mini of g.campus ?? []) {
    roof = Math.max(
      roof,
      PODIUM_HISO +
        miniHIso(mini.building.height) -
        g.hIso +
        townRoofRiseIso(mini.building.rect, cam.scale, true) * mini.roofFactor,
    );
  }
  const sx0 = (g.aabb.u0 - cam.offsetX) * cam.scale;
  const sx1 = (g.aabb.u1 - cam.offsetX) * cam.scale;
  const sy0 = (g.aabb.v0 - roof - cam.offsetY) * cam.scale;
  const sy1 = (g.aabb.v1 - cam.offsetY) * cam.scale;
  return sx1 >= 0 && sy1 >= 0 && sx0 <= viewW && sy0 <= viewH;
}

/** Screen point of a mini-building's rooftop center (podium lift included) —
 *  the anchor its hover tooltip hangs from. */
export function buildingAnchorScreen(cam: Camera, b: MapBuilding): { x: number; y: number } {
  const cx = b.rect.x + b.rect.w / 2;
  const cy = b.rect.y + b.rect.h / 2;
  const u = cx - cy;
  const v =
    (cx + cy) / 2 - PODIUM_HISO - miniHIso(b.height) - townRoofRiseIso(b.rect, cam.scale, true);
  return { x: (u - cam.offsetX) * cam.scale, y: (v - cam.offsetY) * cam.scale };
}

const byBlockCache = new WeakMap<FileMapResponse, Map<string, MapBuilding[]>>();

/** Symbol buildings grouped by block, memoized per payload. Model order is
 *  kept — for grid-laid minis that is already back-to-front paint order. */
export function buildingsForBlock(model: FileMapResponse, blockId: string): MapBuilding[] {
  let map = byBlockCache.get(model);
  if (!map) {
    map = new Map();
    for (const b of model.buildings) {
      const arr = map.get(b.blockId);
      if (arr) arr.push(b);
      else map.set(b.blockId, [b]);
    }
    byBlockCache.set(model, map);
  }
  return map.get(blockId) ?? EMPTY_BUILDINGS;
}
const EMPTY_BUILDINGS: MapBuilding[] = [];

/**
 * The symbol mini-building under a screen point, within one (already hit)
 * podium block: minis stand on the podium, so each is a prism raised by
 * `PODIUM_HISO` — shift the query down by that much and test front-to-back.
 */
export function hitTestIsoBuilding(
  model: FileMapResponse,
  blockId: string,
  cam: Camera,
  sx: number,
  sy: number,
): MapBuilding | null {
  const u = sx / cam.scale + cam.offsetX;
  const v = sy / cam.scale + cam.offsetY + PODIUM_HISO;
  const minis = buildingsForBlock(model, blockId);
  const parent = model.blocks?.find((block) => block.id === blockId);
  for (let i = minis.length - 1; i >= 0; i--) {
    const b = minis[i]!;
    const roofFactor = parent ? (townStyleForSymbol(b, parent).roofFactor ?? 1) : 1;
    if (
      hitsPrism(
        u,
        v,
        b.rect,
        miniHIso(b.height) + townRoofRiseIso(b.rect, cam.scale, true) * roofFactor,
      )
    ) {
      return b;
    }
  }
  return null;
}

/**
 * Topmost block under a screen point: iterate FRONT-to-back (reverse painter
 * order) with the exact prism test, so a short foreground building beats a
 * tall one behind it.
 */
export function hitTestIso(
  geom: GeometryCache,
  cam: Camera,
  sx: number,
  sy: number,
  campuses = true,
): MapBlock | null {
  const u = sx / cam.scale + cam.offsetX;
  const v = sy / cam.scale + cam.offsetY;
  for (let i = geom.order.length - 1; i >= 0; i--) {
    const g = geom.geoms[geom.order[i]!]!;
    if (campuses && g.campus?.length) {
      for (let j = g.campus.length - 1; j >= 0; j--) {
        const mini = g.campus[j]!;
        if (
          hitsPrism(
            u,
            v + PODIUM_HISO,
            mini.building.rect,
            miniHIso(mini.building.height) +
              townRoofRiseIso(mini.building.rect, cam.scale, true) * mini.roofFactor,
          )
        )
          return g.block;
      }
      if (hitsPrism(u, v, g.block.rect, PODIUM_HISO)) return g.block;
      continue;
    }
    if (hitsPrism(u, v, g.block.rect, g.hIso + roofHeadroom(g, cam.scale))) return g.block;
  }
  return null;
}
