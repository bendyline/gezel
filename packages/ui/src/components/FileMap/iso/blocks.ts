import type { MapBlock, MapBuilding } from '@bendyline/gezel';
import type { LodTier } from '../camera.js';
import { decorForModel } from '../decor.js';
import { crosshatchPattern } from '../draw/util.js';
import {
  drawIssueMarker,
  issueMarkerStyle,
  issueMarkerZoomScale,
  representativeIssueBuilding,
} from '../issue-marker.js';
import { ageBucket, prismColors } from '../palette.js';
import { hash32, seeded } from '../seed.js';
import { urbanityOf } from '../urbanity.js';
import {
  type BlockGeom,
  buildingAnchorScreen,
  buildingsForBlock,
  geomInView,
  roofHeadroom,
} from './geometry.js';
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
import { type IsoRenderState, sp } from './state.js';
import { drawTownBuilding } from './town-buildings.js';
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
): boolean {
  return tier !== 'city' && ageLens !== true && placedMiniCount > 0;
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
      batch.add(colors.top, ...diamondPts(s, b));
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
  const representative = shouldDrawSymbolCampus(s.tier, s.ageLens, minis.length)
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
  const minis = shouldDrawSymbolCampus(s.tier, s.ageLens, placedMinis.length)
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
    drawPodiumBuildings(ctx, s, minis, podiumPrism.liftPx, b, colors);
    return;
  }

  const style = g.style ?? townStyleForBlock(b);
  const massing = s.ageLens ? null : massingPrism(s, b, g, style);
  // An N/W wing paints BEFORE the main mass and an S/E wing after, so the
  // secondary volume occludes correctly against its own building.
  if (massing?.behind) drawMassing(ctx, s, massing.prism, style, colors);
  drawTownBuilding(ctx, s, prism, style, colors, {
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
}

const NO_MINIS: MapBuilding[] = [];

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
): void {
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
    drawTownBuilding(ctx, s, lifted, symbolStyle, miniColors, {
      compact: true,
      suppressDetails: s.ageLens === true,
    });
    ctx.globalAlpha = 1;
  }
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
