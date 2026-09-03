import type { MapBlock } from '@bendyline/gezel';
import { rectInView } from '../camera.js';
import { hasSymbolCampus } from '../file-use.js';
import type { TownStyle } from '../iso/town-style.js';
import { ageBucket, roofColors } from '../palette.js';
import { hash32, seeded } from '../seed.js';
import { styleForBlock } from '../town-cache.js';
import { bandOf, urbanityOf } from '../urbanity.js';
import type { RenderState } from './state.js';
import { type ScreenRect, crosshatchPattern, roundRect, screenRect } from './util.js';

// Fixed screen-space shadow offset — a soft ambient drop, not a scaled sun.
const SHADOW_OX = 1.5;
const SHADOW_OY = 2.5;
/** Below this screen width a block renders flat — 3D at that size is mud. */
const MIN_3D_PX = 6;

interface VisibleBlock {
  b: MapBlock;
  r: ScreenRect;
  age: 0 | 1 | 2 | 3 | null | undefined;
}

/**
 * At street zoom a block with symbols becomes a paved lot and its symbol
 * buildings carry the 3D; symbol-less blocks stay buildings so they don't
 * vanish into empty pavement.
 */
function isLotAtStreet(s: RenderState, b: MapBlock): boolean {
  return s.tier === 'street' && hasSymbolCampus(b);
}

export function drawBlocks(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const p = s.palette;
  const now = s.now ?? Date.now();
  const vis: VisibleBlock[] = [];
  for (const b of s.model.blocks) {
    if (!rectInView(s.cam, b.rect, s.viewW, s.viewH)) continue;
    vis.push({
      b,
      r: screenRect(s.cam, b.rect),
      // Real git history when the server has it; placement time otherwise.
      age: s.ageLens ? ageBucket(b.lastTouchedAt ?? b.placedAt, now) : undefined,
    });
  }

  // lot-ground pass: plazas and blight tints sit under everything built
  if (s.tier !== 'city' && !s.ageLens) {
    for (const v of vis) drawLotGround(ctx, s, v);
  }

  // shadow pass next: one fillStyle for every shadow in the frame
  if (s.tier !== 'city') {
    ctx.fillStyle = p.shadow;
    for (const { b, r } of vis) {
      if (b.state !== 'live' && !s.ageLens) continue;
      if (b.phantom || r.w < MIN_3D_PX || isLotAtStreet(s, b)) continue;
      roundRect(ctx, r.x + SHADOW_OX, r.y + SHADOW_OY, r.w, r.h, Math.min(3, r.w / 6));
      ctx.fill();
    }
  }

  for (const v of vis) drawBlock(ctx, s, v);
}

/** Zone/vibe ground treatment on the lot: civic plaza, blighted earth, plus
 *  the plot boundary — see `drawPlot`. */
function drawLotGround(ctx: CanvasRenderingContext2D, s: RenderState, v: VisibleBlock): void {
  const { b } = v;
  const p = s.palette;
  if (b.state !== 'live' || b.phantom || !b.lot || !b.health) return;
  const lr = screenRect(s.cam, b.lot);
  if (lr.w < 10) return;
  drawPlot(ctx, s, b, lr);
  const { vibe, zone, maxSeverity } = b.health;
  if (zone === 'civic') {
    ctx.fillStyle = p.sidewalk;
    roundRect(ctx, lr.x, lr.y, lr.w, lr.h, 3);
    ctx.fill();
    ctx.strokeStyle = p.domeAccent;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    roundRect(ctx, lr.x + 1.5, lr.y + 1.5, lr.w - 3, lr.h - 3, 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (vibe === 'scruffy' || vibe === 'blighted') {
    ctx.fillStyle = p.earth;
    ctx.globalAlpha = vibe === 'blighted' ? 0.45 : 0.3;
    roundRect(ctx, lr.x, lr.y, lr.w, lr.h, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (vibe === 'blighted' && maxSeverity === 'critical') {
      ctx.strokeStyle = p.crane;
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1;
      roundRect(ctx, lr.x, lr.y, lr.w, lr.h, 3);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

/**
 * The plot: ground tone plus a hedge / picket / curb boundary by register.
 *
 * In top-down projection this is the single strongest village-versus-city
 * signal available — stronger than anything that can be said on the buildings
 * themselves, since silhouette is gone and only roof plan survives. Worth
 * prioritizing accordingly.
 */
function drawPlot(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  b: MapBlock,
  lr: ScreenRect,
): void {
  const p = s.palette;
  const u = urbanityOf(b);
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = u < 0.25 ? p.orchard : u < 0.5 ? p.ground : p.sidewalk;
  roundRect(ctx, lr.x, lr.y, lr.w, lr.h, 3);
  ctx.fill();
  ctx.globalAlpha = 1;

  const band = bandOf(b);
  if (band === 'city' && u > 0.78) return;
  if (band === 'village') {
    // Ticks rather than a line, so the boundary reads as planting.
    ctx.strokeStyle = p.hedge;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of [
      [lr.x, lr.y, lr.x + lr.w, lr.y],
      [lr.x + lr.w, lr.y, lr.x + lr.w, lr.y + lr.h],
      [lr.x + lr.w, lr.y + lr.h, lr.x, lr.y + lr.h],
      [lr.x, lr.y + lr.h, lr.x, lr.y],
    ] as const) {
      const steps = Math.max(1, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 5));
      for (let k = 0; k < steps; k++) {
        const t0 = (k + 0.15) / steps;
        const t1 = (k + 0.85) / steps;
        ctx.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0);
        ctx.lineTo(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
      }
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
    return;
  }
  ctx.strokeStyle = band === 'town' ? p.fence : p.curb;
  ctx.lineWidth = 1;
  if (band === 'town') ctx.setLineDash([2, 2]);
  roundRect(ctx, lr.x, lr.y, lr.w, lr.h, 3);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawBlock(ctx: CanvasRenderingContext2D, s: RenderState, v: VisibleBlock): void {
  const { b, r, age } = v;
  const p = s.palette;

  if (b.state === 'tombstoned') {
    drawVacantLot(ctx, s, v);
    return;
  }
  if (b.phantom) {
    drawScaffold(ctx, s, v);
    return;
  }
  // Under the age lens every block tells one story: recency. Construction /
  // decoration treatments are suppressed so the ramp stays legible.
  if (b.state === 'new' && !s.ageLens) {
    drawConstructionSite(ctx, s, v);
    return;
  }

  const colors = roofColors(b.lang, p, age);
  const corner = Math.min(3, r.w / 6);
  const style = styleForBlock(s.model, b);

  // Fields and parks are ground, not buildings, in plan as in iso.
  if (!s.ageLens && (style.archetype === 'field' || style.archetype === 'park')) {
    drawGroundPlan(ctx, s, v, style, colors.roof);
    return;
  }

  if (s.tier === 'city' || r.w < MIN_3D_PX) {
    ctx.fillStyle = colors.roof;
    roundRect(ctx, r.x, r.y, r.w, r.h, corner);
    ctx.fill();
    if (r.w > 3) {
      ctx.strokeStyle = p.blockStroke;
      ctx.lineWidth = 0.5;
      roundRect(ctx, r.x, r.y, r.w, r.h, corner);
      ctx.stroke();
    }
    return;
  }

  if (isLotAtStreet(s, b)) {
    // paved lot with a language tint; the symbol buildings sit on top
    ctx.fillStyle = p.sidewalk;
    roundRect(ctx, r.x, r.y, r.w, r.h, corner);
    ctx.fill();
    ctx.fillStyle = colors.roof;
    ctx.globalAlpha = 0.28;
    roundRect(ctx, r.x, r.y, r.w, r.h, corner);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = p.blockStroke;
    ctx.lineWidth = 0.5;
    roundRect(ctx, r.x, r.y, r.w, r.h, corner);
    ctx.stroke();
    return;
  }

  // top-down oblique: facade strip at the bottom, roof above, lit NW edge
  const wallH = Math.min(
    Math.max(2, Math.sqrt(Math.max(1, b.weight)) * 0.15 * s.cam.scale),
    8,
    r.h * 0.35,
  );
  ctx.fillStyle = colors.facade;
  roundRect(ctx, r.x, r.y, r.w, r.h, corner);
  ctx.fill();
  ctx.fillStyle = colors.roof;
  roundRect(ctx, r.x, r.y, r.w, r.h - wallH, corner);
  ctx.fill();
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(r.x + corner, r.y + 0.5);
  ctx.lineTo(r.x + r.w - corner, r.y + 0.5);
  ctx.stroke();

  if (!s.ageLens) drawRoofPlan(ctx, s, v, r.h - wallH, colors, style);
}

/** A field (crop with furrows) or a park (lawn, path cross, flowerbed) in plan. */
function drawGroundPlan(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  v: VisibleBlock,
  style: TownStyle,
  hue: string,
): void {
  const { r } = v;
  const p = s.palette;
  const corner = Math.min(3, r.w / 6);
  if (style.archetype === 'field') {
    ctx.fillStyle = p.farm.crops[(style.seed >>> 4) % 4]!;
    roundRect(ctx, r.x, r.y, r.w, r.h, corner);
    ctx.fill();
    if (s.tier !== 'city' && r.w >= 10) {
      const step = Math.max(3, 1.6 * s.cam.scale);
      const alongX = style.ridge === 'x';
      ctx.strokeStyle = p.farm.furrow;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      const span = alongX ? r.h : r.w;
      for (let off = step / 2; off < span; off += step) {
        if (alongX) {
          ctx.moveTo(r.x + 1, r.y + off);
          ctx.lineTo(r.x + r.w - 1, r.y + off);
        } else {
          ctx.moveTo(r.x + off, r.y + 1);
          ctx.lineTo(r.x + off, r.y + r.h - 1);
        }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    return;
  }
  ctx.fillStyle = p.park.lawn;
  roundRect(ctx, r.x, r.y, r.w, r.h, corner);
  ctx.fill();
  if (s.tier === 'city' || r.w < 10) return;
  const pathW = Math.max(1, Math.min(r.w, r.h) * 0.1);
  ctx.fillStyle = p.park.path;
  ctx.fillRect(r.x, r.y + r.h / 2 - pathW / 2, r.w, pathW);
  ctx.fillRect(r.x + r.w / 2 - pathW / 2, r.y, pathW, r.h);
  const bed = Math.min(r.w, r.h) * 0.3;
  ctx.fillStyle = hue;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(r.x + r.w / 2 - bed / 2, r.y + r.h / 2 - bed / 2, bed, bed);
  ctx.globalAlpha = 1;
}

/**
 * The roof in PLAN.
 *
 * The flat view used to re-derive its own architecture from `health.zone`,
 * independently of the isometric vocabulary — which is exactly why the two
 * renderers disagreed about what a given file looked like. Both now read the
 * same resolved `TownStyle` out of the shared per-model cache, and this
 * function's only job is to express that struct in top-down terms.
 *
 * Top-down, silhouette is unavailable and roof PLAN is the readable signal:
 * a hip is a shortened ridge with four hip lines running to the corners, a
 * mansard is an inset deck, a parapet has no ridge at all. Storeys, cornices,
 * and stoops simply do not survive the projection and are not attempted.
 */
function drawRoofPlan(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  v: VisibleBlock,
  roofH: number,
  colors: { roof: string; facade: string; edge: string },
  style: TownStyle,
): void {
  const { r } = v;
  if (style.roof === 'sawtooth' && roofH >= 12) {
    drawIndustrialRoof(ctx, s, v, roofH, colors.facade, colors.edge);
    return;
  }
  if (r.w < 14 || roofH < 10) return;

  const horizontal = style.ridge === 'x' ? r.w >= roofH : r.w < roofH;
  const cx = r.x + r.w / 2;
  const cy = r.y + roofH / 2;
  const line = (x0: number, y0: number, x1: number, y1: number, width = 1) => {
    ctx.strokeStyle = colors.edge;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  /** Two tone halves either side of the ridge — the pitched-roof cue. */
  const slopes = (t: number) => {
    ctx.globalAlpha = 0.22;
    if (horizontal) {
      ctx.fillStyle = colors.edge;
      ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, roofH * t - 1);
      ctx.fillStyle = colors.facade;
      ctx.fillRect(r.x + 1, r.y + roofH * t, r.w - 2, roofH * (1 - t) - 1);
    } else {
      ctx.fillStyle = colors.edge;
      ctx.fillRect(r.x + 1, r.y + 1, r.w * t - 1, roofH - 2);
      ctx.fillStyle = colors.facade;
      ctx.fillRect(r.x + r.w * t, r.y + 1, r.w * (1 - t) - 1, roofH - 2);
    }
    ctx.globalAlpha = 1;
  };
  /** The ridge, optionally shortened to the middle fraction (hips). */
  const ridge = (span = 1) => {
    const m = (1 - span) / 2;
    if (horizontal) line(r.x + 1 + (r.w - 2) * m, cy, r.x + r.w - 1 - (r.w - 2) * m, cy);
    else line(cx, r.y + 1 + (roofH - 2) * m, cx, r.y + roofH - 1 - (roofH - 2) * m);
  };
  /** Four hip lines running from the ridge ends out to the corners. */
  const hips = (span: number) => {
    const m = (1 - span) / 2;
    const [a, b] = horizontal
      ? ([
          { x: r.x + 1 + (r.w - 2) * m, y: cy },
          { x: r.x + r.w - 1 - (r.w - 2) * m, y: cy },
        ] as const)
      : ([
          { x: cx, y: r.y + 1 + (roofH - 2) * m },
          { x: cx, y: r.y + roofH - 1 - (roofH - 2) * m },
        ] as const);
    line(a.x, a.y, r.x + 1, r.y + 1, 0.7);
    line(
      a.x,
      a.y,
      horizontal ? r.x + 1 : r.x + r.w - 1,
      horizontal ? r.y + roofH - 1 : r.y + 1,
      0.7,
    );
    line(b.x, b.y, r.x + r.w - 1, r.y + roofH - 1, 0.7);
    line(
      b.x,
      b.y,
      horizontal ? r.x + r.w - 1 : r.x + 1,
      horizontal ? r.y + 1 : r.y + roofH - 1,
      0.7,
    );
  };
  /** An inset deck, lighter than the slopes around it. */
  const deck = (inset: number) => {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = colors.edge;
    ctx.fillRect(
      r.x + r.w * inset,
      r.y + roofH * inset,
      r.w * (1 - inset * 2),
      roofH * (1 - inset * 2),
    );
    ctx.globalAlpha = 1;
  };

  switch (style.roof) {
    case 'gable':
      slopes(0.5);
      ridge();
      break;
    case 'catslide':
      // Off-center ridge: one plane runs long to a lower eave.
      slopes(0.34);
      if (horizontal) line(r.x + 1, r.y + roofH * 0.34, r.x + r.w - 1, r.y + roofH * 0.34);
      else line(r.x + r.w * 0.34, r.y + 1, r.x + r.w * 0.34, r.y + roofH - 1);
      break;
    case 'thatch': {
      // The fat overhanging eave is the whole cue, so give it real weight.
      slopes(0.5);
      ridge(0.8);
      ctx.strokeStyle = colors.facade;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = Math.max(2, Math.min(4, roofH * 0.16));
      roundRect(ctx, r.x + 1.5, r.y + 1.5, r.w - 3, roofH - 3, Math.min(roofH, r.w) / 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      break;
    }
    case 'hip':
      slopes(0.5);
      ridge(0.5);
      hips(0.5);
      break;
    case 'half-hip':
      slopes(0.5);
      ridge(0.76);
      hips(0.76);
      break;
    case 'shed':
      slopes(0.82);
      break;
    case 'mansard':
      deck(0.24);
      hips(0.5);
      break;
    case 'parapet':
      // No ridge at all — a flat deck behind a raised rim.
      ctx.strokeStyle = colors.edge;
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, roofH - 3);
      deck(0.18);
      break;
    case 'monitor': {
      slopes(0.5);
      const bandH = Math.max(2, roofH * 0.22);
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = colors.edge;
      if (horizontal) ctx.fillRect(r.x + 2, cy - bandH / 2, r.w - 4, bandH);
      else ctx.fillRect(cx - bandH / 2, r.y + 2, bandH, roofH - 4);
      ctx.globalAlpha = 1;
      ridge();
      break;
    }
    case 'pyramid':
      line(r.x + 1, r.y + 1, r.x + r.w - 1, r.y + roofH - 1, 0.8);
      line(r.x + r.w - 1, r.y + 1, r.x + 1, r.y + roofH - 1, 0.8);
      break;
    case 'conical': {
      const rad = Math.min(r.w, roofH) * 0.42;
      ctx.strokeStyle = colors.edge;
      ctx.lineWidth = 0.9;
      for (const k of [1, 0.45]) {
        ctx.beginPath();
        ctx.arc(cx, cy, rad * k, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case 'barrel': {
      ctx.strokeStyle = colors.edge;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      for (const k of [0.3, 0.5, 0.7]) {
        if (horizontal) {
          ctx.moveTo(r.x + 2, r.y + roofH * k);
          ctx.lineTo(r.x + r.w - 2, r.y + roofH * k);
        } else {
          ctx.moveTo(r.x + r.w * k, r.y + 2);
          ctx.lineTo(r.x + r.w * k, r.y + roofH - 2);
        }
      }
      ctx.stroke();
      break;
    }
    default:
      slopes(0.5);
      ridge();
      break;
  }

  // A terrace's party walls: strokes across the roof at the bay divisions,
  // perpendicular to the ridge. Unmistakable in plan and nearly free.
  //
  // These are drawn WITHIN one block, not between neighbours — the layout
  // always puts a street or a yard margin between blocks, so a real shared
  // wall is impossible here. Don't try to "fix" that in the renderer.
  if (style.band === 'city' && style.bays > 1 && r.w >= 20) {
    ctx.strokeStyle = colors.facade;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let i = 1; i < Math.min(5, style.bays); i++) {
      const t = i / style.bays;
      if (horizontal) {
        ctx.moveTo(r.x + r.w * t, r.y + 1);
        ctx.lineTo(r.x + r.w * t, r.y + roofH - 1);
      } else {
        ctx.moveTo(r.x + 1, r.y + roofH * t);
        ctx.lineTo(r.x + r.w - 1, r.y + roofH * t);
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Chimney dots and cupola circles survive the projection surprisingly well.
  if (style.chimneys > 0 && roofH >= 12) {
    ctx.fillStyle = s.palette.masonry;
    for (let i = 0; i < Math.min(3, style.chimneys); i++) {
      const t = style.chimneys === 1 ? 0.5 : 0.3 + (i / (style.chimneys - 1)) * 0.4;
      const x = horizontal ? r.x + r.w * t : cx;
      const y = horizontal ? cy : r.y + roofH * t;
      ctx.fillRect(x - 1, y - 1, 2.2, 2.2);
    }
  }
  if (style.cupola && roofH >= 12) {
    const rad = Math.min(r.w, roofH) * 0.16;
    ctx.fillStyle = s.palette.domeAccent;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.facade;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Sawtooth strips + vent stacks: the big-machinery look for huge files. */
function drawIndustrialRoof(
  ctx: CanvasRenderingContext2D,
  _s: RenderState,
  v: VisibleBlock,
  roofH: number,
  facade: string,
  edge: string,
): void {
  const { b, r } = v;
  ctx.fillStyle = facade;
  ctx.globalAlpha = 0.3;
  const strips = 3;
  for (let i = 1; i <= strips; i++) {
    const sy = r.y + (roofH * i) / (strips + 1);
    ctx.fillRect(r.x + 1, sy, r.w - 2, Math.max(1.5, roofH * 0.1));
  }
  ctx.globalAlpha = 1;
  const rng = seeded(hash32(b.id));
  ctx.fillStyle = edge;
  for (let i = 0; i < 2; i++) {
    const size = 2 + rng() * 2;
    const vx = r.x + 2 + rng() * Math.max(1, r.w - size - 4);
    const vy = r.y + 2 + rng() * Math.max(1, roofH - size - 4);
    ctx.fillRect(vx, vy, size, size);
  }
}

/** Tombstone → vacant lot: bare earth, scattered rubble, broken outline. */
function drawVacantLot(ctx: CanvasRenderingContext2D, s: RenderState, v: VisibleBlock): void {
  const { b, r } = v;
  const p = s.palette;
  const corner = Math.min(3, r.w / 6);
  ctx.fillStyle = s.ageLens ? p.tombstone : p.earth;
  ctx.globalAlpha = s.ageLens ? 0.4 : 0.7;
  roundRect(ctx, r.x, r.y, r.w, r.h, corner);
  ctx.fill();
  ctx.globalAlpha = 1;
  if (s.tier !== 'city' && r.w >= 10 && !s.ageLens) {
    const rng = seeded(hash32(b.id));
    const n = 4 + Math.floor(rng() * 4);
    ctx.fillStyle = p.rubble;
    for (let i = 0; i < n; i++) {
      const size = Math.min(5, Math.max(1, (0.06 + 0.08 * rng()) * Math.min(r.w, r.h)));
      const cx = r.x + r.w * (0.12 + 0.76 * rng());
      const cy = r.y + r.h * (0.12 + 0.76 * rng());
      ctx.fillRect(cx, cy, size, size);
    }
    ctx.strokeStyle = p.blockStroke;
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([3, 3]);
    roundRect(ctx, r.x, r.y, r.w, r.h, corner);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
}

/** `new` state → construction site: earth lot, dashed edge, crane accent. */
function drawConstructionSite(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  v: VisibleBlock,
): void {
  const { b, r } = v;
  const p = s.palette;
  const corner = Math.min(3, r.w / 6);
  if (s.tier === 'city' || r.w < MIN_3D_PX) {
    ctx.fillStyle = p.newBlock;
    roundRect(ctx, r.x, r.y, r.w, r.h, corner);
    ctx.fill();
    return;
  }
  ctx.fillStyle = p.earth;
  roundRect(ctx, r.x, r.y, r.w, r.h, corner);
  ctx.fill();
  ctx.strokeStyle = p.newBlock;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  roundRect(ctx, r.x, r.y, r.w, r.h, corner);
  ctx.stroke();
  ctx.setLineDash([]);
  if (s.tier === 'street' && r.w >= 14) {
    const rng = seeded(hash32(b.id));
    const mastX = r.x + r.w * (0.25 + 0.5 * rng());
    const baseY = r.y + r.h * 0.85;
    const topY = r.y + r.h * 0.2;
    const jib = r.w * 0.4 * (rng() < 0.5 ? -1 : 1);
    ctx.strokeStyle = p.crane;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mastX, baseY);
    ctx.lineTo(mastX, topY);
    ctx.lineTo(mastX + jib, topY);
    ctx.moveTo(mastX + jib * 0.8, topY);
    ctx.lineTo(mastX + jib * 0.8, topY + r.h * 0.15);
    ctx.stroke();
  }
}

/** PR phantom ("new construction" not yet indexed) → scaffolding. */
function drawScaffold(ctx: CanvasRenderingContext2D, s: RenderState, v: VisibleBlock): void {
  const { b, r } = v;
  const p = s.palette;
  const corner = Math.min(3, r.w / 6);
  const colors = roofColors(b.lang, p);
  ctx.fillStyle = colors.roof;
  ctx.globalAlpha = 0.25;
  roundRect(ctx, r.x, r.y, r.w, r.h, corner);
  ctx.fill();
  ctx.globalAlpha = 1;
  const pattern = crosshatchPattern(ctx, p.dark ? '#8b8f99' : '#8a7f64');
  if (pattern) {
    ctx.fillStyle = pattern;
    roundRect(ctx, r.x, r.y, r.w, r.h, corner);
    ctx.fill();
  }
  ctx.strokeStyle = p.blockStroke;
  ctx.setLineDash([4, 3]);
  roundRect(ctx, r.x, r.y, r.w, r.h, corner);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Selection / hover strokes, painted over the buildings. */
export function drawBlockChrome(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const p = s.palette;
  const stroke = (id: string, color: string, width: number): void => {
    const b = s.model.blocks.find((blk) => blk.id === id);
    if (!b || !rectInView(s.cam, b.rect, s.viewW, s.viewH)) return;
    const r = screenRect(s.cam, b.rect);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    roundRect(ctx, r.x, r.y, r.w, r.h, Math.min(3, r.w / 6));
    ctx.stroke();
  };
  if (s.hoverId && s.hoverId !== s.selectedId) stroke(s.hoverId, p.hover, 1.5);
  if (s.selectedId) stroke(s.selectedId, p.selected, 2);
}
