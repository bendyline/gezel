import type { Rect } from '@bendyline/gezel';
import type { Camera } from '../camera.js';
import { isoCorners } from './projection.js';
import { type ScreenPt, sp } from './state.js';

/**
 * Prism geometry + path helpers. A prism shows three faces from the fixed
 * dimetric view: the top diamond and the two south-facing walls (SW = left,
 * SE = right), NW-lit. All flat fills — depth reads from the tone steps.
 */

export interface PrismScreen {
  /** Ground corners (N, E, S, W) in screen space. */
  gn: ScreenPt;
  ge: ScreenPt;
  gs: ScreenPt;
  gw: ScreenPt;
  /** Lifted (top) corners. */
  tn: ScreenPt;
  te: ScreenPt;
  ts: ScreenPt;
  tw: ScreenPt;
  /** Screen height of the extrusion in px. */
  liftPx: number;
}

export function prismScreen(cam: Camera, r: Rect, hIso: number): PrismScreen {
  const c = isoCorners(r);
  const gn = sp(cam, c.n.u, c.n.v);
  const ge = sp(cam, c.e.u, c.e.v);
  const gs = sp(cam, c.s.u, c.s.v);
  const gw = sp(cam, c.w.u, c.w.v);
  const liftPx = hIso * cam.scale;
  return {
    gn,
    ge,
    gs,
    gw,
    tn: { x: gn.x, y: gn.y - liftPx },
    te: { x: ge.x, y: ge.y - liftPx },
    ts: { x: gs.x, y: gs.y - liftPx },
    tw: { x: gw.x, y: gw.y - liftPx },
    liftPx,
  };
}

export function pathQuad(
  ctx: CanvasRenderingContext2D,
  a: ScreenPt,
  b: ScreenPt,
  c: ScreenPt,
  d: ScreenPt,
): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
}

export function fillQuad(
  ctx: CanvasRenderingContext2D,
  color: string,
  a: ScreenPt,
  b: ScreenPt,
  c: ScreenPt,
  d: ScreenPt,
): void {
  ctx.fillStyle = color;
  pathQuad(ctx, a, b, c, d);
  ctx.fill();
}

/** The prism's outer silhouette hexagon (selection/hover chrome). */
export function pathSilhouette(ctx: CanvasRenderingContext2D, p: PrismScreen): void {
  ctx.beginPath();
  ctx.moveTo(p.tn.x, p.tn.y);
  ctx.lineTo(p.te.x, p.te.y);
  ctx.lineTo(p.ge.x, p.ge.y);
  ctx.lineTo(p.gs.x, p.gs.y);
  ctx.lineTo(p.gw.x, p.gw.y);
  ctx.lineTo(p.tw.x, p.tw.y);
  ctx.closePath();
}

/** Draw the three faces of a prism (or just the top diamond when flat). */
export function drawPrism(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  colors: { top: string; wallL: string; wallR: string },
): void {
  if (p.liftPx >= 0.5) {
    fillQuad(ctx, colors.wallL, p.tw, p.ts, p.gs, p.gw); // SW wall
    fillQuad(ctx, colors.wallR, p.ts, p.te, p.ge, p.gs); // SE wall
  }
  fillQuad(ctx, colors.top, p.tn, p.te, p.ts, p.tw);
}

/**
 * Color-batched flat diamonds for the city tier: disjoint ground rects
 * project to disjoint diamonds, so cross-block batching is order-safe there
 * (extruded prisms are NOT batched — their images overlap, and painter order
 * must hold).
 */
export class DiamondBatcher {
  private buckets = new Map<string, number[]>();

  add(color: string, a: ScreenPt, b: ScreenPt, c: ScreenPt, d: ScreenPt): void {
    let arr = this.buckets.get(color);
    if (!arr) {
      arr = [];
      this.buckets.set(color, arr);
    }
    arr.push(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
  }

  flush(ctx: CanvasRenderingContext2D): void {
    for (const [color, pts] of this.buckets) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 8) {
        ctx.moveTo(pts[i]!, pts[i + 1]!);
        ctx.lineTo(pts[i + 2]!, pts[i + 3]!);
        ctx.lineTo(pts[i + 4]!, pts[i + 5]!);
        ctx.lineTo(pts[i + 6]!, pts[i + 7]!);
        ctx.closePath();
      }
      ctx.fill();
    }
    this.buckets.clear();
  }
}
