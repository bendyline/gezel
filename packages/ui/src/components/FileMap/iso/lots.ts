import type { MapBlock } from '@bendyline/gezel';
import { bandOf, urbanityOf } from '../urbanity.js';
import { isoCorners } from './projection.js';
import { type IsoRenderState, type ScreenPt, sp } from './state.js';

/**
 * The parcel a building stands on: garden, yard, or pavement, plus the boundary
 * that encloses it.
 *
 * This is the strongest village-versus-city signal the renderer has, and the
 * cheapest — one fill and one stroke per block. A hedged garden plot reads as
 * countryside at any zoom where the lot is visible at all, whereas a thatched
 * roof needs district zoom before it resolves into anything.
 *
 * Drawn INSIDE the depth loop, immediately before each block's own prism, so a
 * lot can never paint over a neighbour the depth sort placed in front of it.
 */

/** Below this projected lot width the fill and boundary stop reading. */
const MIN_LOT_PX = 12;
/** Hedge tick spacing along a boundary, in screen px. */
const HEDGE_STEP = 5;
/** Past this urbanity the footprint effectively fills the lot: no boundary. */
const PAVED_OVER = 0.78;

export function drawIsoLot(ctx: CanvasRenderingContext2D, s: IsoRenderState, b: MapBlock): void {
  if (s.tier === 'city' || s.ageLens) return;
  const lot = b.lot;
  if (!lot || b.state === 'tombstoned' || b.phantom) return;
  if ((lot.w + lot.h) * s.cam.scale < MIN_LOT_PX) return;

  const c = isoCorners(lot);
  const quad: [ScreenPt, ScreenPt, ScreenPt, ScreenPt] = [
    sp(s.cam, c.n.u, c.n.v),
    sp(s.cam, c.e.u, c.e.v),
    sp(s.cam, c.s.u, c.s.v),
    sp(s.cam, c.w.u, c.w.v),
  ];
  const u = urbanityOf(b);
  const p = s.palette;

  // Ground: garden green out in the fields, paving in the core. Continuous, so
  // a whole map reads as a gradient rather than as four concentric rings.
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = u < 0.25 ? p.orchard : u < 0.5 ? p.ground : p.sidewalk;
  pathQuad(ctx, quad);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Boundary: hedge → picket → curb → nothing. Categorical, so it reads the
  // server's bucket instead of re-thresholding the float.
  const band = bandOf(b);
  if (band === 'city' && u > PAVED_OVER) return;
  if (band === 'village') {
    drawHedge(ctx, s, quad);
    return;
  }
  ctx.strokeStyle = band === 'town' ? p.fence : p.curb;
  ctx.lineWidth = 1;
  if (band === 'town') ctx.setLineDash([2, 2]);
  pathQuad(ctx, quad);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * A hedge is a run of short ticks rather than a continuous line, so it reads as
 * planting instead of fencing. Vector, and every tick of one lot goes into a
 * single path.
 *
 * Deliberately NOT sprites: a screenful of village lanes at street zoom would
 * be thousands of blits, and it would starve `MAX_BLITS` — the yard decor
 * budget — for something that is, in the end, a green line.
 */
function drawHedge(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  quad: readonly [ScreenPt, ScreenPt, ScreenPt, ScreenPt],
): void {
  ctx.strokeStyle = s.palette.hedge;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const z = quad[(i + 1) % 4]!;
    const steps = Math.max(1, Math.floor(Math.hypot(z.x - a.x, z.y - a.y) / HEDGE_STEP));
    for (let k = 0; k < steps; k++) {
      const t0 = (k + 0.15) / steps;
      const t1 = (k + 0.85) / steps;
      ctx.moveTo(a.x + (z.x - a.x) * t0, a.y + (z.y - a.y) * t0 - 1);
      ctx.lineTo(a.x + (z.x - a.x) * t1, a.y + (z.y - a.y) * t1 - 1);
    }
  }
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function pathQuad(
  ctx: CanvasRenderingContext2D,
  [a, b, c, d]: readonly [ScreenPt, ScreenPt, ScreenPt, ScreenPt],
): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
}
