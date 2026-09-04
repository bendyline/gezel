import type { Rect } from '@bendyline/gezel';
import {
  type StreetGeometry,
  streetPoint,
  streetSurfaceColor,
  trafficLayoutForModel,
  vehicleAlong,
} from '../traffic.js';
import { districtBands } from '../urbanity.js';
import { drawPrism, pathGroundRect, prismScreen } from './prism.js';
import { HZ, groundRectInView, toIso } from './projection.js';
import { type IsoRenderState, type ScreenPt, sp } from './state.js';

/**
 * The street pass of the iso ground plane, in the order a road is built:
 * verges, sidewalks, carriageways (lowest grade first, so a busy avenue is
 * never overpainted by the dirt lane that crosses it), surface texture and
 * curbs, trolley rails, then — at street zoom — lamps, overhead-line poles,
 * avenue trees, and the traffic itself: carts, walkers, and trolley cars
 * moving along their streets on the frame clock.
 *
 * Everything here is a function of `trafficLayoutForModel` (world space,
 * once per payload) and the camera. Vehicles are drawn on the ground plane
 * BEFORE the buildings: a building south or east of a cart paints later and
 * correctly occludes it; one north or west never reaches it on screen.
 */

/** Screen thickness, per world unit, of a band running ACROSS a street in the
 *  2:1 dimetric view: the perpendicular component of (−w, w/2)·scale. */
const ACROSS = 2 / Math.sqrt(5);
/** Screen length per world unit ALONG a street: |(1, 1/2)|. */
const ALONG = Math.sqrt(5) / 2;

/** Below this projected sidewalk thickness the band is a smear; the
 *  carriageway takes the whole reservation instead. */
const MIN_SIDEWALK_PX = 1.2;
const MIN_DETAIL_PX = 4;
const MIN_RAIL_PAIR_PX = 2.4;
const COBBLE_STEP = 2.6;
const SLAB_STEP = 4;
const MAX_TICKS = 400;

const TROLLEY = { length: 5.5, width: 1.9, height: 2.4 };
const CART = { length: 2.4, width: 1.2, height: 1.1 };
const HORSE = { length: 1.4, width: 0.6, height: 1.2, lead: 2.1 };
/** Iso height of a lamp post (~two thirds of a storey) and a trolley pole. */
const LAMP_H = 1.3;
const POLE_H = 2.2;

export function drawIsoStreets(ctx: CanvasRenderingContext2D, s: IsoRenderState): void {
  const { cam, model, palette, viewW, viewH } = s;
  const layout = trafficLayoutForModel(model);
  if (layout.streets.length === 0) return;
  const visible = layout.streets.filter((g) => groundRectInView(cam, g.reservation, viewW, viewH));
  if (visible.length === 0) return;
  const scale = cam.scale;

  if (s.tier === 'city') {
    // The overview stays quiet: the wide reservations only, one fill per
    // surface, no furniture. Lanes are sub-pixel noise at this zoom.
    const byColor = new Map<string, StreetGeometry[]>();
    for (const g of visible) {
      if (g.street.tier > 1) continue;
      const color = streetSurfaceColor(g, palette);
      const list = byColor.get(color);
      if (list) list.push(g);
      else byColor.set(color, [g]);
    }
    for (const [color, list] of byColor) {
      ctx.fillStyle = color;
      for (const g of list) {
        pathGroundRect(ctx, cam, g.carriageway);
        ctx.fill();
      }
    }
    return;
  }

  const bands = districtBands(model);
  const bandOf = (g: StreetGeometry) =>
    g.street.districtId ? bands.get(g.street.districtId) : undefined;
  const sidewalksVisible = (g: StreetGeometry): boolean =>
    g.sidewalks !== null && g.sidewalkWidth * ACROSS * scale >= MIN_SIDEWALK_PX;

  ctx.fillStyle = palette.street.verge;
  for (const g of visible) {
    if (!g.spec.verge || bandOf(g) === 'city') continue;
    pathGroundRect(ctx, cam, g.reservation);
    ctx.fill();
  }

  ctx.fillStyle = palette.sidewalk;
  for (const g of visible) {
    if (!g.sidewalks || !sidewalksVisible(g)) continue;
    for (const band of g.sidewalks) {
      pathGroundRect(ctx, cam, band);
      ctx.fill();
    }
  }

  // The age lens keeps one clean surface per file; street life would compete
  // with it, so furniture and traffic sit this one out along with the decor.
  const detail = s.tier === 'street' && !s.ageLens;
  const ordered = [...visible].sort((a, b) => a.grade - b.grade || b.street.tier - a.street.tier);
  for (const g of ordered) {
    // A street whose sidewalks are too thin to draw takes the whole
    // reservation, so a grade-5 lane at district zoom still reads as paved
    // edge to edge instead of leaving a gutter of bare ground.
    const rect = g.sidewalks && !sidewalksVisible(g) ? g.reservation : g.carriageway;
    ctx.fillStyle = streetSurfaceColor(g, palette);
    pathGroundRect(ctx, cam, rect);
    ctx.fill();
    if (detail && g.carriagewayWidth * ACROSS * scale >= MIN_DETAIL_PX) {
      drawSurfaceDetail(ctx, s, g, sidewalksVisible(g));
    }
  }

  for (const g of visible) if (g.rails) drawRails(ctx, s, g);

  if (!detail) return;
  for (const g of visible) drawFurniture(ctx, s, g);
  for (const g of visible) drawVehicles(ctx, s, g);
}

function screenPt(s: IsoRenderState, x: number, y: number): ScreenPt {
  const iso = toIso(x, y);
  return sp(s.cam, iso.u, iso.v);
}

function onScreen(s: IsoRenderState, pt: ScreenPt, margin = 40): boolean {
  return pt.x >= -margin && pt.x <= s.viewW + margin && pt.y >= -margin && pt.y <= s.viewH + margin;
}

/** Stroke a world-space segment across/along a street. */
function segment(ctx: CanvasRenderingContext2D, s: IsoRenderState, a: ScreenPt, b: ScreenPt): void {
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
}

function drawSurfaceDetail(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  g: StreetGeometry,
  sidewalks: boolean,
): void {
  const scale = s.cam.scale;
  const half = g.carriagewayWidth / 2;
  const at = (along: number, cross: number): ScreenPt => {
    const p = streetPoint(g, along, cross);
    return screenPt(s, p.x, p.y);
  };

  switch (g.spec.surface) {
    case 'dirt': {
      // Two wheel ruts, broken like a track that is used but never made up.
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.24)';
      ctx.lineWidth = Math.max(0.6, 0.32 * scale);
      ctx.setLineDash([3.2 * ALONG * scale, 2.4 * ALONG * scale]);
      ctx.beginPath();
      for (const cross of [-half * 0.42, half * 0.42]) {
        segment(ctx, s, at(g.a0 + 1, cross), at(g.a1 - 1, cross));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
    case 'cobble': {
      // Setts: a course line down the middle and cross joints every few
      // units, alternately offset so the carriageway never reads as a ladder.
      ctx.strokeStyle = s.palette.curb;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = Math.max(0.5, 0.2 * scale);
      ctx.beginPath();
      segment(ctx, s, at(g.a0 + 0.5, 0), at(g.a1 - 0.5, 0));
      const n = Math.min(MAX_TICKS, Math.floor(g.length / COBBLE_STEP));
      for (let i = 0; i < n; i++) {
        const along = g.a0 + COBBLE_STEP * (i + 0.5);
        if (i % 2 === 0) segment(ctx, s, at(along, -half * 0.85), at(along, 0));
        else segment(ctx, s, at(along, 0), at(along, half * 0.85));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      break;
    }
    case 'paved': {
      if (g.grade < 4) break;
      // A made-up road has curbs; on a sidewalk street they are the step
      // between footway and carriageway.
      ctx.strokeStyle = s.palette.curb;
      ctx.globalAlpha = sidewalks ? 0.85 : 0.55;
      ctx.lineWidth = Math.max(0.6, 0.26 * scale);
      ctx.beginPath();
      segment(ctx, s, at(g.a0, -half), at(g.a1, -half));
      segment(ctx, s, at(g.a0, half), at(g.a1, half));
      ctx.stroke();
      ctx.globalAlpha = 1;
      break;
    }
  }

  if (sidewalks && g.sidewalkWidth * ACROSS * scale >= 3) {
    // Paving-slab joints across each footway.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.lineWidth = Math.max(0.5, 0.18 * scale);
    ctx.beginPath();
    const n = Math.min(MAX_TICKS, Math.floor(g.length / SLAB_STEP));
    const outer = half + g.sidewalkWidth;
    for (let i = 0; i < n; i++) {
      const along = g.a0 + SLAB_STEP * (i + 0.5);
      segment(ctx, s, at(along, -outer), at(along, -half));
      segment(ctx, s, at(along, half), at(along, outer));
    }
    ctx.stroke();
  }
}

function drawRails(ctx: CanvasRenderingContext2D, s: IsoRenderState, g: StreetGeometry): void {
  if (!g.rails) return;
  const scale = s.cam.scale;
  ctx.strokeStyle = s.palette.street.rail;
  ctx.beginPath();
  if (g.gauge * ACROSS * scale >= MIN_RAIL_PAIR_PX) {
    ctx.lineWidth = Math.max(0.7, 0.26 * scale);
    for (const rail of g.rails) {
      segment(ctx, s, screenPt(s, rail.a.x, rail.a.y), screenPt(s, rail.b.x, rail.b.y));
    }
  } else {
    // Too close to resolve as a pair: one dark line still reads as tracks.
    ctx.lineWidth = 1;
    const a = streetPoint(g, g.a0, 0);
    const b = streetPoint(g, g.a1, 0);
    segment(ctx, s, screenPt(s, a.x, a.y), screenPt(s, b.x, b.y));
  }
  ctx.stroke();
}

function drawFurniture(ctx: CanvasRenderingContext2D, s: IsoRenderState, g: StreetGeometry): void {
  const scale = s.cam.scale;
  const p = s.palette;

  if (g.lamps.length > 0) {
    const h = LAMP_H * scale;
    const headR = Math.max(0.8, 0.3 * scale);
    const posts: ScreenPt[] = [];
    for (const lamp of g.lamps) {
      const pt = screenPt(s, lamp.x, lamp.y);
      if (onScreen(s, pt)) posts.push(pt);
    }
    if (posts.length > 0) {
      if (p.dark) {
        // Gas light at dusk: a soft pool under each head, before the post so
        // the post reads over it.
        ctx.fillStyle = p.street.lampGlow;
        ctx.globalAlpha = 0.1;
        for (const pt of posts) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y - h, 1.3 * scale, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = p.street.lampPost;
      ctx.lineWidth = Math.max(0.6, 0.22 * scale);
      ctx.beginPath();
      for (const pt of posts) {
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x, pt.y - h);
      }
      ctx.stroke();
      ctx.fillStyle = p.street.lampGlow;
      for (const pt of posts) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y - h, headR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  if (g.poles.length > 0) {
    const h = POLE_H * scale;
    const arm = 0.7 * scale * (g.horizontal ? -1 : 1);
    const tops: ScreenPt[] = [];
    ctx.strokeStyle = p.street.pole;
    ctx.lineWidth = Math.max(0.7, 0.24 * scale);
    ctx.beginPath();
    for (const pole of g.poles) {
      const pt = screenPt(s, pole.x, pole.y);
      const top = { x: pt.x, y: pt.y - h };
      tops.push(top);
      if (!onScreen(s, pt)) continue;
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(top.x, top.y);
      // Bracket arm reaching over the carriageway.
      ctx.moveTo(top.x, top.y + 0.3 * scale);
      ctx.lineTo(top.x + arm, top.y + 0.3 * scale);
    }
    ctx.stroke();
    // The overhead wire, pole to pole, sagging a touch between them.
    ctx.strokeStyle = p.street.wire;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(0.5, 0.14 * scale);
    ctx.beginPath();
    for (let i = 1; i < tops.length; i++) {
      const a = tops[i - 1]!;
      const b = tops[i]!;
      if (!onScreen(s, a, 200) && !onScreen(s, b, 200)) continue;
      ctx.moveTo(a.x + arm, a.y + 0.3 * scale);
      ctx.quadraticCurveTo(
        (a.x + b.x) / 2 + arm,
        (a.y + b.y) / 2 + 0.3 * scale + 0.35 * scale,
        b.x + arm,
        b.y + 0.3 * scale,
      );
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (g.trees.length > 0 && s.atlas) {
    for (const t of g.trees) {
      const pt = screenPt(s, t.x, t.y);
      if (!onScreen(s, pt)) continue;
      const size = t.size * scale * 2;
      const src = s.atlas.index[t.sprite] * s.atlas.cell;
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

/** World footprint of a vehicle centred at `along` on the street. */
function vehicleRect(
  g: StreetGeometry,
  along: number,
  cross: number,
  length: number,
  width: number,
): Rect {
  const c = streetPoint(g, along, cross);
  return g.horizontal
    ? { x: c.x - length / 2, y: c.y - width / 2, w: length, h: width }
    : { x: c.x - width / 2, y: c.y - length / 2, w: width, h: length };
}

function drawVehicles(ctx: CanvasRenderingContext2D, s: IsoRenderState, g: StreetGeometry): void {
  if (g.vehicles.length === 0) return;
  const t = s.animationTime ?? 0;
  const p = s.palette;
  for (const v of g.vehicles) {
    const along = vehicleAlong(g, v, t);
    switch (v.kind) {
      case 'trolley':
        drawTrolley(ctx, s, g, along);
        break;
      case 'cart': {
        const cart = vehicleRect(g, along, v.cross, CART.length, CART.width);
        const c = screenPt(s, cart.x + cart.w / 2, cart.y + cart.h / 2);
        if (!onScreen(s, c)) break;
        const horse = vehicleRect(
          g,
          along + v.dir * HORSE.lead,
          v.cross,
          HORSE.length,
          HORSE.width,
        );
        // The horse leads; on a street running toward the viewer it is the
        // nearer of the two and must paint second.
        const horseFirst = v.dir === -1;
        if (horseFirst)
          drawPrism(ctx, prismScreen(s.cam, horse, HORSE.height * HZ), p.street.horse);
        drawPrism(ctx, prismScreen(s.cam, cart, CART.height * HZ), p.street.cart);
        if (!horseFirst)
          drawPrism(ctx, prismScreen(s.cam, horse, HORSE.height * HZ), p.street.horse);
        break;
      }
      case 'walker': {
        const w = streetPoint(g, along, v.cross);
        const pt = screenPt(s, w.x, w.y);
        if (!onScreen(s, pt)) break;
        const bw = Math.max(1, 0.32 * s.cam.scale);
        const bh = Math.max(2, 0.95 * s.cam.scale);
        ctx.fillStyle = p.street.walker;
        ctx.fillRect(pt.x - bw / 2, pt.y - bh, bw, bh);
        break;
      }
    }
  }
}

function drawTrolley(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  g: StreetGeometry,
  along: number,
): void {
  const p = s.palette;
  const rect = vehicleRect(g, along, 0, TROLLEY.length, TROLLEY.width);
  const centre = screenPt(s, rect.x + rect.w / 2, rect.y + rect.h / 2);
  if (!onScreen(s, centre, 60)) return;
  const prism = prismScreen(s.cam, rect, TROLLEY.height * HZ);
  drawPrism(ctx, prism, p.street.trolley);
  if (prism.liftPx >= 5) {
    // Lit saloon windows down the long side, and the trolley pole reaching
    // the wire the poles carry.
    const [a, b, c, d] = g.horizontal
      ? [prism.tw, prism.ts, prism.gs, prism.gw]
      : [prism.ts, prism.te, prism.ge, prism.gs];
    ctx.fillStyle = p.dark ? p.windowLit : p.window;
    const n = 4;
    for (let i = 0; i < n; i++) {
      const u0 = (i + 0.2) / n;
      const u1 = (i + 0.8) / n;
      const top0 = lerp(a, b, u0);
      const top1 = lerp(a, b, u1);
      const bot0 = lerp(d, c, u0);
      const bot1 = lerp(d, c, u1);
      ctx.beginPath();
      ctx.moveTo(lerp(top0, bot0, 0.2).x, lerp(top0, bot0, 0.2).y);
      ctx.lineTo(lerp(top1, bot1, 0.2).x, lerp(top1, bot1, 0.2).y);
      ctx.lineTo(lerp(top1, bot1, 0.6).x, lerp(top1, bot1, 0.6).y);
      ctx.lineTo(lerp(top0, bot0, 0.6).x, lerp(top0, bot0, 0.6).y);
      ctx.closePath();
      ctx.fill();
    }
    const roof = { x: centre.x, y: centre.y - prism.liftPx };
    ctx.strokeStyle = p.street.pole;
    ctx.lineWidth = Math.max(0.6, 0.18 * s.cam.scale);
    ctx.beginPath();
    ctx.moveTo(roof.x, roof.y);
    ctx.lineTo(roof.x + (g.horizontal ? -0.7 : 0.7) * s.cam.scale, centre.y - POLE_H * s.cam.scale);
    ctx.stroke();
  }
}

function lerp(a: ScreenPt, b: ScreenPt, t: number): ScreenPt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
