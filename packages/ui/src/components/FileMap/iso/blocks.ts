import type { MapBlock, MapBuilding } from '@bendyline/gezel';
import type { LodTier } from '../camera.js';
import { decorForModel } from '../decor.js';
import { crosshatchPattern } from '../draw/util.js';
import { hasSymbolCampus } from '../file-use.js';
import {
  drawIssueMarker,
  issueMarkerStyle,
  issueMarkerZoomScale,
  representativeIssueBuilding,
} from '../issue-marker.js';
import { type CityPalette, ageBucket, prismColors } from '../palette.js';
import { hash32, seeded } from '../seed.js';
import { urbanityOf } from '../urbanity.js';
import {
  type BlockGeom,
  buildingAnchorScreen,
  buildingsForBlock,
  geomInView,
  roofHeadroom,
} from './geometry.js';
import { drawFountainAt } from './ground.js';
import { drawIsoLot } from './lots.js';
import {
  DiamondBatcher,
  type PrismScreen,
  drawPrism,
  fillQuad,
  pathQuad,
  pathSilhouette,
  prismScreen,
} from './prism.js';
import {
  HZ,
  LEVEL_H,
  PODIUM_HISO,
  isoCorners,
  miniHIso,
  toIso,
  townRoofRiseIso,
} from './projection.js';
import { drawChimneySmoke } from './smoke.js';
import { type IsoRenderState, type ScreenPt, sp } from './state.js';
import { drawParkFeature, drawTownBuilding } from './town-buildings.js';
import { type TownStyle, townStyleForBlock, townStyleForSymbol } from './town-style.js';

/**
 * The building pass: every block drawn back-to-front as an extruded prism —
 * floors, zone silhouettes, landmarks, construction/vacant/phantom states,
 * podium courtyards for symbol-carrying files, and yard decor, all inside the
 * depth order so occlusion is correct. City tier collapses to color-batched
 * flat diamonds (order-safe: disjoint ground rects project disjoint).
 */

const MIN_DETAIL_PX = 14;

/**
 * Keep a symbol-carrying file recognizable as the same little campus while
 * zooming between neighborhood and street views. City view still collapses
 * everything to flat lots, and the age lens keeps one simple color surface per
 * file so its recency signal stays legible.
 */
export function shouldDrawSymbolCampus(
  tier: LodTier,
  ageLens: boolean | undefined,
  placedMiniCount: number,
  block: Pick<MapBlock, 'id' | 'lang' | 'buildingCount'>,
): boolean {
  return tier !== 'city' && ageLens !== true && placedMiniCount > 0 && hasSymbolCampus(block);
}

export function drawIsoBlocks(ctx: CanvasRenderingContext2D, s: IsoRenderState): void {
  const now = s.now ?? Date.now();
  const decor = s.tier === 'street' && !s.ageLens && s.atlas ? decorForModel(s.model) : null;

  if (s.tier === 'city') {
    const batch = new DiamondBatcher();
    const landmarks: BlockGeom[] = [];
    for (const idx of s.geom.order) {
      const g = s.geom.geoms[idx]!;
      if (!geomInView(s.cam, g, s.viewW, s.viewH)) continue;
      const b = g.block;
      const age = s.ageLens ? ageBucket(b.lastTouchedAt ?? b.placedAt, now) : undefined;
      if (b.state === 'tombstoned') {
        batch.add(s.ageLens ? s.palette.tombstone : s.palette.earth, ...diamondPts(s, b));
        continue;
      }
      if (b.state === 'new' && !s.ageLens && !b.phantom) {
        batch.add(s.palette.newBlock, ...diamondPts(s, b));
        continue;
      }
      const colors = prismColors(b.lang, s.palette, age);
      // Fields and parks keep their ground reading at the overview too: a
      // data district is farmland from the air, not a roof field.
      const top = s.ageLens
        ? colors.top
        : g.style?.archetype === 'field'
          ? cropColor(g.style, s.palette)
          : g.style?.archetype === 'park'
            ? s.palette.park.lawn
            : colors.top;
      batch.add(top, ...diamondPts(s, b));
      if (b.landmark) landmarks.push(g);
    }
    batch.flush(ctx);
    // Landmark beacons stay visible at city zoom — the skyline's wayfinders.
    ctx.fillStyle = s.palette.domeAccent;
    for (const g of landmarks) {
      const c = centerTop(s, g);
      ctx.beginPath();
      ctx.arc(c.x, c.y - 3, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  for (const idx of s.geom.order) {
    const g = s.geom.geoms[idx]!;
    if (!geomInView(s.cam, g, s.viewW, s.viewH)) continue;
    // The parcel goes down first, inside the depth loop, so it can never paint
    // over a neighbour the sort placed in front of this block.
    drawIsoLot(ctx, s, g.block);
    drawOneBlock(ctx, s, g, now);
    if (decor) {
      const list = decor.get(g.block.id);
      if (list && s.atlas) {
        for (const d of list) {
          const iso = toIso(d.x, d.y);
          const pt = sp(s.cam, iso.u, iso.v);
          const size = d.size * s.cam.scale * 2;
          const src = s.atlas.index[d.sprite] * s.atlas.cell;
          ctx.drawImage(
            s.atlas.canvas,
            src,
            0,
            s.atlas.cell,
            s.atlas.cell,
            pt.x - size / 2,
            pt.y - size,
            size,
            size,
          );
        }
      }
    }
    drawIsoIssueMarker(ctx, s, g);
  }
}

function drawIsoIssueMarker(ctx: CanvasRenderingContext2D, s: IsoRenderState, g: BlockGeom): void {
  if (s.ageLens) return;
  const style = issueMarkerStyle(g.block);
  if (!style) return;

  const minis = buildingsForBlock(s.model, g.block.id);
  const representative = shouldDrawSymbolCampus(s.tier, s.ageLens, minis.length, g.block)
    ? representativeIssueBuilding(minis)
    : null;
  const anchor = representative
    ? buildingAnchorScreen(s.cam, representative)
    : mainRoofAnchor(s, g);
  drawIssueMarker(
    ctx,
    s.palette,
    style,
    anchor.x,
    anchor.y,
    g.block.id,
    issueMarkerZoomScale(s.cam.scale),
    s.animationTime ?? 0,
  );
}

function mainRoofAnchor(s: IsoRenderState, g: BlockGeom): { x: number; y: number } {
  const anchor = centerTop(s, g);
  return {
    x: anchor.x,
    y: anchor.y - roofHeadroom(g, s.cam.scale) * s.cam.scale,
  };
}

function diamondPts(
  s: IsoRenderState,
  b: MapBlock,
): [
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
  { x: number; y: number },
] {
  const c = isoCorners(b.rect);
  return [
    sp(s.cam, c.n.u, c.n.v),
    sp(s.cam, c.e.u, c.e.v),
    sp(s.cam, c.s.u, c.s.v),
    sp(s.cam, c.w.u, c.w.v),
  ];
}

function centerTop(s: IsoRenderState, g: BlockGeom): { x: number; y: number } {
  const r = g.block.rect;
  const iso = toIso(r.x + r.w / 2, r.y + r.h / 2);
  const pt = sp(s.cam, iso.u, iso.v);
  return { x: pt.x, y: pt.y - g.hIso * s.cam.scale };
}

function drawOneBlock(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  g: BlockGeom,
  now: number,
): void {
  const b = g.block;
  const p = s.palette;
  const [n, e, sPt, w] = diamondPts(s, b);
  const widthPx = e.x - w.x;

  if (b.state === 'tombstoned') {
    ctx.fillStyle = s.ageLens ? p.tombstone : p.earth;
    ctx.globalAlpha = s.ageLens ? 0.4 : 0.7;
    pathQuad(ctx, n, e, sPt, w);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (widthPx >= 10 && !s.ageLens) {
      const rng = seeded(hash32(b.id));
      ctx.fillStyle = p.rubble;
      const count = 4 + Math.floor(rng() * 4);
      for (let i = 0; i < count; i++) {
        const rx = b.rect.x + b.rect.w * (0.12 + 0.76 * rng());
        const ry = b.rect.y + b.rect.h * (0.12 + 0.76 * rng());
        const iso = toIso(rx, ry);
        const pt = sp(s.cam, iso.u, iso.v);
        const size = Math.min(4, Math.max(1, 0.1 * widthPx * rng()));
        ctx.fillRect(pt.x, pt.y - size / 2, size, size / 2 + 1);
      }
      ctx.strokeStyle = p.blockStroke;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([3, 3]);
      pathQuad(ctx, n, e, sPt, w);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    return;
  }

  const prism = prismScreen(s.cam, b.rect, g.hIso);

  if (b.phantom) {
    const age = s.ageLens ? ageBucket(b.lastTouchedAt ?? b.placedAt, now) : undefined;
    const colors = prismColors(b.lang, p, age);
    ctx.globalAlpha = 0.3;
    drawPrism(ctx, prismScreen(s.cam, b.rect, LEVEL_H * HZ), colors);
    ctx.globalAlpha = 1;
    const pattern = crosshatchPattern(ctx, p.dark ? '#8b8f99' : '#8a7f64');
    if (pattern) {
      ctx.fillStyle = pattern;
      pathQuad(ctx, n, e, sPt, w);
      ctx.fill();
    }
    ctx.strokeStyle = p.blockStroke;
    ctx.setLineDash([4, 3]);
    pathQuad(ctx, n, e, sPt, w);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  if (b.state === 'new' && !s.ageLens) {
    // Construction site: bare earth, dashed edge, screen-space crane.
    ctx.fillStyle = p.earth;
    pathQuad(ctx, n, e, sPt, w);
    ctx.fill();
    ctx.strokeStyle = p.newBlock;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    pathQuad(ctx, n, e, sPt, w);
    ctx.stroke();
    ctx.setLineDash([]);
    if (s.tier === 'street' && widthPx >= MIN_DETAIL_PX) {
      const rng = seeded(hash32(b.id));
      const cx = (w.x + e.x) / 2 + (rng() - 0.5) * widthPx * 0.3;
      const baseY = (n.y + sPt.y) / 2 + (sPt.y - n.y) * 0.2;
      const topY = baseY - Math.max(12, widthPx * 0.5);
      const jib = widthPx * 0.35 * (rng() < 0.5 ? -1 : 1);
      ctx.strokeStyle = p.crane;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, baseY);
      ctx.lineTo(cx, topY);
      ctx.lineTo(cx + jib, topY);
      ctx.moveTo(cx + jib * 0.8, topY);
      ctx.lineTo(cx + jib * 0.8, topY + Math.max(6, widthPx * 0.15));
      ctx.stroke();
    }
    return;
  }

  const age = s.ageLens ? ageBucket(b.lastTouchedAt ?? b.placedAt, now) : undefined;
  // Material is a district-and-closer treatment: at city tier everything goes
  // through the DiamondBatcher, which buckets by color string, so per-building
  // materials there would multiply the bucket count for detail nobody can see.
  const material =
    g.style && !s.ageLens && s.tier !== 'city'
      ? {
          ...g.style.material,
          urbanity: urbanityOf(b),
          variance: ((g.style.seed >>> 8) % 200) / 100 - 1,
        }
      : undefined;
  const colors = prismColors(b.lang, p, age, material);
  // Gate on placed minis, not `buildingCount`: past the payload cap a
  // symbol-carrying block has no buildings and must read as a normal prism,
  // not an empty parking lot.
  const placedMinis = b.buildingCount > 0 ? buildingsForBlock(s.model, b.id) : NO_MINIS;
  const minis = shouldDrawSymbolCampus(s.tier, s.ageLens, placedMinis.length, b)
    ? placedMinis
    : NO_MINIS;

  if (minis.length > 0) {
    // Symbol-carrying file: a low paved podium with the symbols standing on it
    // as mini-prisms. At district zoom this is a quiet silhouette preview; at
    // street zoom it gains facade details and yard decor.
    const podiumPrism = prismScreen(s.cam, b.rect, PODIUM_HISO);
    drawPrism(ctx, podiumPrism, {
      top: p.sidewalk,
      wallL: colors.wallL,
      wallR: colors.wallR,
    });
    ctx.globalAlpha = 0.25;
    fillQuad(ctx, colors.top, podiumPrism.tn, podiumPrism.te, podiumPrism.ts, podiumPrism.tw);
    ctx.globalAlpha = 1;
    const stacks = drawPodiumBuildings(ctx, s, minis, podiumPrism.liftPx, b, colors);
    drawIndustrialSmoke(ctx, s, b, stacks);
    return;
  }

  const style = g.style ?? townStyleForBlock(b);
  if (!s.ageLens && style.archetype === 'field') {
    drawField(ctx, s, g, style);
    return;
  }
  if (!s.ageLens && style.archetype === 'park') {
    drawPark(ctx, s, g, style, colors);
    return;
  }
  const massing = s.ageLens ? null : massingPrism(s, b, g, style);
  // An N/W wing paints BEFORE the main mass and an S/E wing after, so the
  // secondary volume occludes correctly against its own building.
  if (massing?.behind) drawMassing(ctx, s, massing.prism, style, colors);
  const paint = drawTownBuilding(ctx, s, prism, style, colors, {
    suppressDetails: s.ageLens === true,
  });
  if (massing && !massing.behind) drawMassing(ctx, s, massing.prism, style, colors);
  // NW edge highlight along the top-north rim.
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(prism.tw.x, prism.tw.y);
  ctx.lineTo(prism.tn.x, prism.tn.y);
  ctx.lineTo(prism.te.x, prism.te.y);
  ctx.stroke();
  drawIndustrialSmoke(ctx, s, b, paint.stacks);
}

const NO_MINIS: MapBuilding[] = [];

function cropColor(style: TownStyle, p: CityPalette): string {
  return p.farm.crops[(style.seed >>> 4) % 4]!;
}

/** Furrow spacing in world units by tier. */
const FURROW_STEP = { district: 3.2, street: 1.6 } as const;
const MAX_FURROWS = 80;

/**
 * A data file is a field: the footprint under crop, furrowed along the ridge
 * axis, with a shed in the corner. No walls, no roof — the parcel itself is
 * the building. Language hue is deliberately dropped here; the crop IS the
 * signal, and a purple wheatfield would say nothing true.
 */
function drawField(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  g: BlockGeom,
  style: TownStyle,
): void {
  const b = g.block;
  const p = s.palette;
  const r = b.rect;
  const [n, e, sPt, w] = diamondPts(s, b);
  const widthPx = e.x - w.x;
  ctx.fillStyle = cropColor(style, p);
  pathQuad(ctx, n, e, sPt, w);
  ctx.fill();

  if (widthPx >= 16) {
    const step = FURROW_STEP[s.tier === 'street' ? 'street' : 'district'];
    const alongX = style.ridge === 'x';
    const span = alongX ? r.h : r.w;
    const count = Math.min(MAX_FURROWS, Math.floor(span / step));
    ctx.strokeStyle = p.farm.furrow;
    ctx.globalAlpha = 0.38;
    ctx.lineWidth = Math.max(0.5, 0.22 * s.cam.scale);
    ctx.beginPath();
    for (let i = 1; i <= count; i++) {
      const off = (i - 0.5) * step;
      const a = alongX ? toIso(r.x + 0.6, r.y + off) : toIso(r.x + off, r.y + 0.6);
      const z = alongX ? toIso(r.x + r.w - 0.6, r.y + off) : toIso(r.x + off, r.y + r.h - 0.6);
      const pa = sp(s.cam, a.u, a.v);
      const pz = sp(s.cam, z.u, z.v);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pz.x, pz.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (widthPx >= 24) {
    // The shed sits in the south-east corner of the plot, the last thing
    // painted so it stands in front of the crop.
    const side = Math.max(2, Math.min(r.w, r.h) * 0.22);
    const shed = { x: r.x + r.w - side - 0.8, y: r.y + r.h - side - 0.8, w: side, h: side * 0.8 };
    drawPrism(ctx, prismScreen(s.cam, shed, LEVEL_H * HZ * 0.55), p.farm.shed);
  }
}

/**
 * A stylesheet is a park: lawn, a gravel cross of paths, a flowerbed in the
 * language hue (the one place a park carries the field's colour), and a
 * centrepiece — bandstand, fountain, or obelisk by seed — with trees at
 * street zoom.
 */
function drawPark(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  g: BlockGeom,
  style: TownStyle,
  colors: { top: string },
): void {
  const b = g.block;
  const p = s.palette;
  const r = b.rect;
  const [n, e, sPt, w] = diamondPts(s, b);
  const widthPx = e.x - w.x;
  ctx.fillStyle = p.park.lawn;
  pathQuad(ctx, n, e, sPt, w);
  ctx.fill();
  if (widthPx < 14) return;

  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const pathW = Math.min(1.4, Math.min(r.w, r.h) * 0.12);
  ctx.fillStyle = p.park.path;
  for (const band of [
    { x: r.x, y: cy - pathW / 2, w: r.w, h: pathW },
    { x: cx - pathW / 2, y: r.y, w: pathW, h: r.h },
  ]) {
    const c = isoCorners(band);
    pathQuad(
      ctx,
      sp(s.cam, c.n.u, c.n.v),
      sp(s.cam, c.e.u, c.e.v),
      sp(s.cam, c.s.u, c.s.v),
      sp(s.cam, c.w.u, c.w.v),
    );
    ctx.fill();
  }

  const bedSide = Math.min(r.w, r.h) * 0.34;
  const bed = { x: cx - bedSide / 2, y: cy - bedSide / 2, w: bedSide, h: bedSide };
  const bc = isoCorners(bed);
  ctx.fillStyle = colors.top;
  ctx.globalAlpha = 0.85;
  pathQuad(
    ctx,
    sp(s.cam, bc.n.u, bc.n.v),
    sp(s.cam, bc.e.u, bc.e.v),
    sp(s.cam, bc.s.u, bc.s.v),
    sp(s.cam, bc.w.u, bc.w.v),
  );
  ctx.fill();
  ctx.globalAlpha = 1;

  if (widthPx >= 30) {
    const centre = sp(s.cam, toIso(cx, cy).u, toIso(cx, cy).v);
    const budget = roofHeadroom(g, s.cam.scale) * s.cam.scale;
    const size = Math.min(r.w, r.h) * 0.3 * s.cam.scale;
    const pick = (style.seed >>> 6) % 3;
    if (pick === 0) drawParkFeature(ctx, s, centre, size, budget, 'bandstand');
    else if (pick === 1) drawFountainAt(ctx, s, centre, size * 0.6);
    else drawParkFeature(ctx, s, centre, size, budget, 'obelisk');
  }

  if (s.tier === 'street' && s.atlas) {
    const rng = seeded(style.seed ^ 0x51ed270b);
    const count = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < count; i++) {
      // Trees stand in the four lawn quarters, off the paths and the bed.
      const qx = i % 2 === 0 ? 0.2 : 0.8;
      const qy = i < 2 ? 0.2 : 0.8;
      const x = r.x + r.w * (qx + (rng() - 0.5) * 0.14);
      const y = r.y + r.h * (qy + (rng() - 0.5) * 0.14);
      const size = (1.8 + rng() * 1.2) * s.cam.scale * 2;
      const sprite = rng() < 0.75 ? 'tree1' : 'tree2';
      const pt = sp(s.cam, toIso(x, y).u, toIso(x, y).v);
      const src = s.atlas.index[sprite] * s.atlas.cell;
      ctx.drawImage(
        s.atlas.canvas,
        src,
        0,
        s.atlas.cell,
        s.atlas.cell,
        pt.x - size / 2,
        pt.y - size,
        size,
        size,
      );
    }
  }
}

/**
 * Working smoke over the industrial zone only, at street zoom. Residential
 * hearths stay quiet: a whole village smoking at once is noise, and a plume
 * is the one cue that says "this is a works" from across the map.
 */
function drawIndustrialSmoke(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  b: MapBlock,
  stacks: readonly ScreenPt[],
): void {
  if (s.tier !== 'street' || s.ageLens || stacks.length === 0) return;
  if (b.health?.zone !== 'industrial') return;
  drawChimneySmoke(ctx, s.palette, stacks, b.id, s.cam.scale, s.animationTime ?? 0);
}

/** Below this projected width a wing is a smudge, not a wing. */
const MIN_MASSING_PX = 26;

/**
 * Project a building's secondary mass, or null when it has none / is too small
 * to read.
 *
 * The sub-rect is normalized inside the block's own footprint by construction
 * (see `Massing`), which is what keeps `iso/depth.ts` correct: it sorts
 * footprints, so any geometry outside the footprint could be occluded by a
 * block the sort believes is behind this one.
 */
function massingPrism(
  s: IsoRenderState,
  b: MapBlock,
  g: BlockGeom,
  style: TownStyle,
): { prism: PrismScreen; behind: boolean } | null {
  const m = style.massing;
  if (m.kind === 'none' || s.tier === 'city') return null;
  const widthPx = (b.rect.w + b.rect.h) * s.cam.scale;
  if (widthPx < MIN_MASSING_PX) return null;
  const rect = {
    x: b.rect.x + b.rect.w * m.u0,
    y: b.rect.y + b.rect.h * m.v0,
    w: b.rect.w * (m.u1 - m.u0),
    h: b.rect.h * (m.v1 - m.v0),
  };
  return { prism: prismScreen(s.cam, rect, g.hIso * m.height), behind: m.behind };
}

function drawMassing(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  prism: PrismScreen,
  style: TownStyle,
  colors: { top: string; wallL: string; wallR: string; edge: string },
): void {
  // The secondary mass is an actual wing or stepped upper floor, not a modern
  // flat-roofed extrusion. Reuse the period painter while stripping furniture
  // that belongs only on the main ridge.
  drawTownBuilding(
    ctx,
    s,
    prism,
    {
      ...style,
      chimneys: 0,
      dormers: 0,
      awning: false,
      cupola: false,
      clock: false,
      cap: 'none',
    },
    colors,
    { compact: true, suppressDetails: s.ageLens === true },
  );
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(prism.tw.x, prism.tw.y);
  ctx.lineTo(prism.tn.x, prism.tn.y);
  ctx.lineTo(prism.te.x, prism.te.y);
  ctx.stroke();
}

function drawPodiumBuildings(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  minis: readonly MapBuilding[],
  podiumLiftPx: number,
  parent: MapBlock,
  colors: ReturnType<typeof prismColors>,
): ScreenPt[] {
  const stacks: ScreenPt[] = [];
  for (let i = 0; i < minis.length; i++) {
    const bld = minis[i]!;
    const mini = prismScreen(s.cam, bld.rect, miniHIso(bld.height));
    const dy = -podiumLiftPx;
    const lifted: PrismScreen = {
      gn: off(mini.gn, dy),
      ge: off(mini.ge, dy),
      gs: off(mini.gs, dy),
      gw: off(mini.gw, dy),
      tn: off(mini.tn, dy),
      te: off(mini.te, dy),
      ts: off(mini.ts, dy),
      tw: off(mini.tw, dy),
      liftPx: mini.liftPx,
    };
    const symbolStyle = townStyleForSymbol(bld, parent);
    // The last mini is front-most in the server's stable paint order, so the
    // landmark cupola stays visible instead of being occluded by its campus.
    if (parent.landmark && i === minis.length - 1) {
      symbolStyle.roof = 'hip';
      symbolStyle.cupola = true;
      symbolStyle.clock = true;
    }
    // Each mini gets its OWN material and tone, rather than sharing the parent
    // block's single color object. A campus is a street of separate buildings;
    // painting them all one color made a file read as one extruded slab, which
    // is especially stark in a single-language repo where every roof shares a
    // hue anyway.
    const miniColors =
      s.ageLens || s.tier === 'city'
        ? colors
        : prismColors(parent.lang, s.palette, undefined, {
            ...symbolStyle.material,
            urbanity: urbanityOf(parent),
            variance: ((symbolStyle.seed >>> 8) % 200) / 100 - 1,
          });
    ctx.globalAlpha = 0.5 + 0.45 * bld.height;
    const paint = drawTownBuilding(ctx, s, lifted, symbolStyle, miniColors, {
      compact: true,
      suppressDetails: s.ageLens === true,
    });
    ctx.globalAlpha = 1;
    // The front-most (last-painted) stacks win: smoke from a mini at the back
    // would drift behind the campus in front of it.
    stacks.unshift(...paint.stacks);
  }
  return stacks;
}

/** Selection / hover chrome: silhouette strokes over the finished city. */
export function drawIsoChrome(ctx: CanvasRenderingContext2D, s: IsoRenderState): void {
  const stroke = (id: string, color: string, width: number): void => {
    const g = s.geom.geoms.find((x) => x.block.id === id);
    if (!g || !geomInView(s.cam, g, s.viewW, s.viewH)) return;
    const prism = prismScreen(s.cam, g.block.rect, g.hIso);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    pathSilhouette(ctx, prism);
    ctx.stroke();
  };
  if (s.hoverId && s.hoverId !== s.selectedId) stroke(s.hoverId, s.palette.hover, 1.5);
  if (s.selectedId) stroke(s.selectedId, s.palette.selected, 2);
}

function off(pt: { x: number; y: number }, dy: number) {
  return { x: pt.x, y: pt.y + dy };
}
