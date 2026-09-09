import type { PrismColors } from '../palette.js';
import { type PrismScreen, fillQuad } from './prism.js';
import type { IsoRenderState, ScreenPt } from './state.js';
import type { RoofRidge } from './town-buildings.js';
import type { TownStyle } from './town-style.js';

/** Limit the opening by storey height so a broad facade never gets strip windows. */
export function sashBounds(
  width: number,
  lift: number,
  rows: number,
  bays: number,
  row: number,
  bay: number,
) {
  const band = 0.72 / rows;
  const v0 = 0.12 + row * band;
  const v1 = Math.min(0.86, v0 + band * 0.58);
  const span = 0.82 / bays;
  const center = 0.09 + (bay + 0.5) * span;
  const opening = Math.min(span * 0.46, (lift * (v1 - v0) * 0.82) / Math.max(1, width));
  return { u0: center - opening / 2, u1: center + opening / 2, v0, v1, span };
}

/** Roof slopes must shade the roof material, never borrow the wall material. */
export function roofShades(colors: PrismColors): PrismColors {
  const shade = (delta: number) =>
    colors.top.replace(
      /(\d+)%\)$/,
      (_, light: string) => `${Math.max(0, Number(light) - delta)}%)`,
    );
  return { ...colors, wallL: shade(9), wallR: shade(17) };
}

function between(a: ScreenPt, b: ScreenPt, t: number): ScreenPt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function drawPeriodAwning(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  p: PrismScreen,
  style: TownStyle,
): void {
  const at = (u: number) => between(between(p.ts, p.te, u), between(p.gs, p.ge, u), 0.58);
  const drop = Math.max(1.5, Math.min(4.5, p.liftPx * 0.14));
  const outer = (u: number) => {
    const pt = at(u);
    return { x: pt.x + drop, y: pt.y + drop };
  };
  const paint = [s.palette.awning, s.palette.hedge, s.palette.window][style.seed % 3]!;
  for (let i = 0; i < 8; i++) {
    const u0 = 0.07 + i * 0.1075;
    const u1 = u0 + 0.1075;
    const a = outer(u0);
    const b = outer(u1);
    const color = i % 2 ? s.palette.sidewalk : paint;
    fillQuad(ctx, color, at(u0), at(u1), b, a);
    fillQuad(ctx, color, a, b, { x: b.x, y: b.y + drop * 0.4 }, { x: a.x, y: a.y + drop * 0.4 });
  }
}

export function drawPeriodFacade(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  p: PrismScreen,
  style: TownStyle,
): void {
  if (p.te.x - p.tw.x < 42 || p.liftPx < 10) return;
  const at = (u: number, v: number) => between(between(p.tw, p.ts, u), between(p.gw, p.gs, u), v);
  const panel = (color: string, u0: number, u1: number, v0: number, v1: number) =>
    fillQuad(ctx, color, at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1));
  const paint = s.palette.dark ? '#4f625a' : ['#526c62', '#795e50', '#656b7d'][style.seed % 3]!;
  if (style.frontage === 'shutters') {
    const bays = Math.max(1, Math.min(3, style.bays));
    const rows = Math.min(3, style.storeys);
    for (let row = 0; row < rows; row++) {
      for (let bay = 0; bay < bays; bay++) {
        const { u0, u1, v0, v1, span } = sashBounds(
          Math.abs(p.ts.x - p.tw.x),
          p.liftPx,
          rows,
          bays,
          row,
          bay,
        );
        panel(paint, u0 - span * 0.17, u0 - span * 0.025, v0, v1);
        panel(paint, u1 + span * 0.025, u1 + span * 0.17, v0, v1);
      }
    }
  } else if (style.frontage === 'bay') {
    const shift = Math.min(4, p.liftPx * 0.12);
    const front = (u: number, v: number) => {
      const a = at(u, v);
      return { x: a.x - shift, y: a.y + shift * 0.5 };
    };
    fillQuad(ctx, paint, at(0.4, 0.35), front(0.46, 0.35), front(0.46, 0.85), at(0.4, 0.9));
    fillQuad(
      ctx,
      s.palette.sidewalk,
      front(0.46, 0.35),
      front(0.76, 0.35),
      front(0.76, 0.87),
      front(0.46, 0.87),
    );
    fillQuad(
      ctx,
      s.palette.window,
      front(0.49, 0.39),
      front(0.73, 0.39),
      front(0.73, 0.75),
      front(0.49, 0.75),
    );
    fillQuad(ctx, paint, at(0.4, 0.32), at(0.8, 0.32), front(0.76, 0.35), front(0.46, 0.35));
    ctx.strokeStyle = s.palette.sidewalk;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const u of [0.57, 0.65]) {
      const a = front(u, 0.39);
      const b = front(u, 0.75);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
}

/** A dressed gable end gives neighboring shops distinct, readable outlines. */
export function drawPeriodGable(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  p: PrismScreen,
  style: TownStyle,
  colors: PrismColors,
  ridge: RoofRidge,
  rise: number,
): void {
  if (!['gable', 'half-hip', 'catslide', 'thatch'].includes(style.roof)) return;
  const a = style.ridge === 'x' ? p.ts : p.tw;
  const b = style.ridge === 'x' ? p.te : p.ts;
  const end = ridge.b;
  const color = style.ridge === 'x' ? colors.wallR : colors.wallL;
  const decorated = style.frontage === 'stepped' || style.frontage === 'pediment';
  // Half hips and catslides have different end geometry; only put a new wall
  // on a true gable, otherwise it would cover their characteristic roof cut.
  if (style.roof !== 'gable' && style.roof !== 'thatch') return;
  const points: ScreenPt[] = [a];
  if (decorated && p.te.x - p.tw.x >= 38) {
    for (const [u, h] of (style.frontage === 'stepped'
      ? [
          [0.12, 0],
          [0.12, 0.28],
          [0.29, 0.28],
          [0.29, 0.6],
          [0.42, 0.6],
          [0.42, 0.93],
          [0.58, 0.93],
          [0.58, 0.6],
          [0.71, 0.6],
          [0.71, 0.28],
          [0.88, 0.28],
          [0.88, 0],
        ]
      : [
          [0.12, 0],
          [0.5, 0.94],
          [0.88, 0],
        ]) as [number, number][]) {
      const pt = between(a, b, u);
      points.push({ x: pt.x, y: pt.y - rise * h });
    }
  } else points.push(end);
  points.push(b);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  for (const pt of points.slice(1)) ctx.lineTo(pt.x, pt.y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = s.palette.sidewalk;
  ctx.lineWidth = decorated ? 1.7 : 1;
  ctx.stroke();
  if (rise < 9) return;
  const center = between(a, b, 0.5);
  const r = Math.min(2.5, rise * 0.1);
  ctx.fillStyle = s.palette.window;
  ctx.beginPath();
  ctx.ellipse(center.x, center.y - rise * 0.37, r, r * 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
}
