import type { PrismColors } from '../palette.js';
import { seeded } from '../seed.js';
import { type PrismScreen, drawPrism, fillQuad } from './prism.js';
import { townRoofRiseIso } from './projection.js';
import type { IsoRenderState, ScreenPt } from './state.js';
import type { RidgeAxis, TownStyle } from './town-style.js';

interface TownDrawOptions {
  compact?: boolean;
  suppressDetails?: boolean;
}

/** Draw one code-generated isometric building in the 1910 town vocabulary. */
export function drawTownBuilding(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  prism: PrismScreen,
  style: TownStyle,
  colors: PrismColors,
  options: TownDrawOptions = {},
): void {
  drawPrism(ctx, prism, colors);

  const compact = options.compact === true;
  const roofPx =
    townRoofRiseIso(
      {
        x: 0,
        y: 0,
        w: Math.max(0, (prism.te.x - prism.tn.x) / s.cam.scale),
        h: Math.max(0, (prism.tn.x - prism.tw.x) / s.cam.scale),
      },
      s.cam.scale,
      compact,
    ) * s.cam.scale;

  if (!options.suppressDetails && s.tier === 'street' && prism.liftPx >= 5) {
    drawFacadeDetails(ctx, s, prism, style, compact);
  }

  switch (style.roof) {
    case 'gable':
      drawGableRoof(ctx, prism, style.ridge, roofPx, colors);
      break;
    case 'hip':
      drawHipRoof(ctx, prism, style.ridge, roofPx, colors);
      break;
    case 'mansard':
      drawMansardRoof(ctx, prism, roofPx, colors);
      break;
    case 'sawtooth':
      drawSawtoothRoof(ctx, prism, style.ridge, roofPx, style.sawteeth, colors);
      break;
    case 'shed':
      drawShedRoof(ctx, prism, style.ridge, roofPx, colors);
      break;
  }

  if (!options.suppressDetails && s.tier === 'street') {
    drawRoofFurniture(ctx, s, prism, style, roofPx, compact);
  }
}

function drawGableRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): void {
  if (ridge === 'x') {
    const a = up(mid(p.tn, p.tw), rise);
    const b = up(mid(p.te, p.ts), rise);
    fillTriangle(ctx, c.wallL, p.tn, p.tw, a);
    fillTriangle(ctx, c.wallR, p.te, b, p.ts);
    fillQuad(ctx, c.top, p.tn, p.te, b, a);
    fillQuad(ctx, c.wallL, a, b, p.ts, p.tw);
    strokeRidge(ctx, c.edge, a, b);
  } else {
    const a = up(mid(p.tn, p.te), rise);
    const b = up(mid(p.tw, p.ts), rise);
    fillTriangle(ctx, c.wallR, p.tn, a, p.te);
    fillTriangle(ctx, c.wallL, p.tw, p.ts, b);
    fillQuad(ctx, c.top, p.tn, a, b, p.tw);
    fillQuad(ctx, c.wallL, a, p.te, p.ts, b);
    strokeRidge(ctx, c.edge, a, b);
  }
}

function drawHipRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): void {
  const [rawA, rawB] =
    ridge === 'x' ? [mid(p.tn, p.tw), mid(p.te, p.ts)] : [mid(p.tn, p.te), mid(p.tw, p.ts)];
  const a = up(lerp(rawA, rawB, 0.24), rise);
  const b = up(lerp(rawA, rawB, 0.76), rise);
  if (ridge === 'x') {
    fillQuad(ctx, c.top, p.tn, p.te, b, a);
    fillTriangle(ctx, c.wallR, p.te, p.ts, b);
    fillQuad(ctx, c.wallL, a, b, p.ts, p.tw);
    fillTriangle(ctx, c.top, p.tn, a, p.tw);
  } else {
    fillQuad(ctx, c.top, p.tn, a, b, p.tw);
    fillTriangle(ctx, c.top, p.tn, p.te, a);
    fillQuad(ctx, c.wallR, a, p.te, p.ts, b);
    fillTriangle(ctx, c.wallL, p.tw, b, p.ts);
  }
  strokeRidge(ctx, c.edge, a, b);
}

function drawMansardRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  rise: number,
  c: PrismColors,
): void {
  const center = quadCenter(p.tn, p.te, p.ts, p.tw);
  const n = up(toward(p.tn, center, 0.32), rise);
  const e = up(toward(p.te, center, 0.32), rise);
  const s = up(toward(p.ts, center, 0.32), rise);
  const w = up(toward(p.tw, center, 0.32), rise);
  fillQuad(ctx, c.top, p.tn, p.te, e, n);
  fillQuad(ctx, c.wallR, p.te, p.ts, s, e);
  fillQuad(ctx, c.wallL, w, s, p.ts, p.tw);
  fillQuad(ctx, c.top, p.tn, n, w, p.tw);
  fillQuad(ctx, c.top, n, e, s, w);
  ctx.strokeStyle = c.edge;
  ctx.lineWidth = 0.8;
  path(ctx, [n, e, s, w], true);
  ctx.stroke();
}

function drawSawtoothRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  requested: number,
  c: PrismColors,
): void {
  const count = Math.max(2, Math.min(5, requested || 3));
  const a0 = ridge === 'x' ? p.tn : p.tw;
  const a1 = ridge === 'x' ? p.tw : p.ts;
  const b0 = ridge === 'x' ? p.te : p.tn;
  const b1 = ridge === 'x' ? p.ts : p.te;
  for (let i = 0; i < count; i++) {
    const t0 = i / count;
    const peakT = (i + 0.68) / count;
    const t1 = (i + 1) / count;
    const la = lerp(a0, a1, t0);
    const lb = lerp(b0, b1, t0);
    const ra = up(lerp(a0, a1, peakT), rise * 0.72);
    const rb = up(lerp(b0, b1, peakT), rise * 0.72);
    const ea = lerp(a0, a1, t1);
    const eb = lerp(b0, b1, t1);
    fillQuad(ctx, c.top, la, lb, rb, ra);
    fillQuad(ctx, c.wallL, ra, rb, eb, ea);
    strokeRidge(ctx, c.edge, ra, rb, 0.65);
  }
}

function drawShedRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): void {
  if (ridge === 'x') {
    const n = up(p.tn, rise);
    const e = up(p.te, rise);
    fillTriangle(ctx, c.wallL, p.tn, p.tw, n);
    fillTriangle(ctx, c.wallR, p.te, e, p.ts);
    fillQuad(ctx, c.top, n, e, p.ts, p.tw);
    strokeRidge(ctx, c.edge, n, e);
  } else {
    const n = up(p.tn, rise);
    const w = up(p.tw, rise);
    fillTriangle(ctx, c.wallR, p.tn, n, p.te);
    fillTriangle(ctx, c.wallL, p.tw, p.ts, w);
    fillQuad(ctx, c.top, n, p.te, p.ts, w);
    strokeRidge(ctx, c.edge, n, w);
  }
}

function drawFacadeDetails(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  p: PrismScreen,
  style: TownStyle,
  compact: boolean,
): void {
  const random = seeded(style.seed ^ 0xa18f35cd);
  const rows = Math.max(1, Math.min(compact ? 2 : 3, style.storeys));
  const bays = Math.max(1, Math.min(compact ? 2 : 4, style.bays));
  const windowColor = () => (random() < 0.24 ? s.palette.windowLit : s.palette.window);

  drawWallWindows(ctx, p.tw, p.ts, p.gw, p.gs, rows, bays, windowColor);
  drawWallWindows(ctx, p.ts, p.te, p.gs, p.ge, rows, Math.max(1, bays - 1), windowColor);

  // A dark, narrow door on the nearer facade keeps the little structures from
  // reading as decorated blocks rather than inhabited buildings.
  const door = wallPatch(p.ts, p.te, p.gs, p.ge, 0.12, 0.3, 0.58, 0.98);
  fillQuad(ctx, s.palette.window, ...door);

  if (style.awning) {
    const awning = wallPatch(p.ts, p.te, p.gs, p.ge, 0.08, 0.92, 0.57, 0.7);
    fillQuad(ctx, s.palette.awning, ...awning);
    ctx.strokeStyle = s.palette.windowLit;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.7;
    for (let i = 1; i < 4; i++) {
      const t = i / 4;
      const a = lerp(awning[0], awning[1], t);
      const b = lerp(awning[3], awning[2], t);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function drawWallWindows(
  ctx: CanvasRenderingContext2D,
  topA: ScreenPt,
  topB: ScreenPt,
  groundA: ScreenPt,
  groundB: ScreenPt,
  rows: number,
  bays: number,
  color: () => string,
): void {
  for (let row = 0; row < rows; row++) {
    const band = 0.72 / rows;
    const v0 = 0.12 + row * band;
    const v1 = Math.min(0.86, v0 + band * 0.43);
    for (let bay = 0; bay < bays; bay++) {
      const span = 0.82 / bays;
      const u0 = 0.09 + bay * span + span * 0.2;
      const u1 = 0.09 + (bay + 1) * span - span * 0.2;
      fillQuad(ctx, color(), ...wallPatch(topA, topB, groundA, groundB, u0, u1, v0, v1));
    }
  }
}

function drawRoofFurniture(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  p: PrismScreen,
  style: TownStyle,
  roofRise: number,
  compact: boolean,
): void {
  const center = quadCenter(p.tn, p.te, p.ts, p.tw);
  const random = seeded(style.seed ^ 0x61c88647);
  const scale = compact ? 0.65 : 1;

  for (let i = 0; i < style.chimneys; i++) {
    const spread = style.chimneys === 1 ? 0 : (i / (style.chimneys - 1) - 0.5) * 0.46;
    const along = style.ridge === 'x' ? p.te.x - p.tw.x : p.ts.x - p.tn.x;
    const x = center.x + spread * along + (random() - 0.5) * 2;
    const y = center.y - roofRise * 0.75 + spread * 0.22 * along;
    drawStack(ctx, x, y, Math.max(1.5, 2.7 * scale), Math.max(4, 7 * scale), s.palette.masonry);
  }

  if (style.cupola && (!compact || style.clock)) {
    const width = Math.max(6, Math.min(13, (p.te.x - p.tw.x) * 0.15));
    drawCupola(ctx, center.x, center.y - roofRise * 0.72, width, style.clock, s);
  }

  if (style.dormers > 0 && !compact && p.te.x - p.tw.x >= 28) {
    const count = Math.min(3, style.dormers);
    for (let i = 0; i < count; i++) {
      const x = center.x + (i - (count - 1) / 2) * 7;
      const y = center.y - roofRise * 0.2 + Math.abs(i - (count - 1) / 2) * 1.5;
      drawDormer(ctx, x, y, s.palette.window, s.palette.masonry);
    }
  }
}

function drawStack(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  const half = width / 2;
  ctx.fillStyle = color;
  path(
    ctx,
    [
      { x: x - half, y },
      { x, y: y + half * 0.45 },
      { x, y: y + height },
      { x: x - half, y: y + height - half * 0.45 },
    ],
    true,
  );
  ctx.fill();
  ctx.globalAlpha = 0.72;
  path(
    ctx,
    [
      { x, y: y + half * 0.45 },
      { x: x + half, y },
      { x: x + half, y: y + height - half * 0.45 },
      { x, y: y + height },
    ],
    true,
  );
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillRect(x - half - 0.5, y - 1, width + 1, 1.5);
}

function drawCupola(
  ctx: CanvasRenderingContext2D,
  x: number,
  roofY: number,
  width: number,
  clock: boolean,
  s: IsoRenderState,
): void {
  const half = width / 2;
  const bodyH = width * 0.85;
  ctx.fillStyle = s.palette.sidewalk;
  ctx.fillRect(x - half * 0.72, roofY - bodyH, width * 0.72, bodyH);
  ctx.fillStyle = s.palette.masonry;
  ctx.globalAlpha = 0.65;
  ctx.fillRect(x, roofY - bodyH + 1, half * 0.72, bodyH - 1);
  ctx.globalAlpha = 1;
  fillTriangle(
    ctx,
    s.palette.domeAccent,
    { x: x - half, y: roofY - bodyH },
    { x, y: roofY - bodyH - width * 0.65 },
    { x: x + half, y: roofY - bodyH },
  );
  if (clock) {
    ctx.fillStyle = s.palette.windowLit;
    ctx.beginPath();
    ctx.arc(x, roofY - bodyH * 0.55, Math.max(1.4, width * 0.12), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = s.palette.window;
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
  ctx.strokeStyle = s.palette.masonry;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(x, roofY - bodyH - width * 0.62);
  ctx.lineTo(x, roofY - bodyH - width * 0.95);
  ctx.stroke();
}

function drawDormer(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  windowColor: string,
  trim: string,
): void {
  ctx.fillStyle = windowColor;
  ctx.fillRect(x - 1.7, y - 3, 3.4, 3.2);
  fillTriangle(ctx, trim, { x: x - 2.4, y: y - 3 }, { x, y: y - 5.2 }, { x: x + 2.4, y: y - 3 });
}

function wallPatch(
  topA: ScreenPt,
  topB: ScreenPt,
  groundA: ScreenPt,
  groundB: ScreenPt,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
): [ScreenPt, ScreenPt, ScreenPt, ScreenPt] {
  const point = (u: number, v: number) => lerp(lerp(topA, topB, u), lerp(groundA, groundB, u), v);
  return [point(u0, v0), point(u1, v0), point(u1, v1), point(u0, v1)];
}

function fillTriangle(
  ctx: CanvasRenderingContext2D,
  color: string,
  a: ScreenPt,
  b: ScreenPt,
  c: ScreenPt,
): void {
  ctx.fillStyle = color;
  path(ctx, [a, b, c], true);
  ctx.fill();
}

function strokeRidge(
  ctx: CanvasRenderingContext2D,
  color: string,
  a: ScreenPt,
  b: ScreenPt,
  width = 0.85,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function path(ctx: CanvasRenderingContext2D, pts: readonly ScreenPt[], close: boolean): void {
  const first = pts[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  if (close) ctx.closePath();
}

function mid(a: ScreenPt, b: ScreenPt): ScreenPt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function lerp(a: ScreenPt, b: ScreenPt, t: number): ScreenPt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function toward(point: ScreenPt, target: ScreenPt, t: number): ScreenPt {
  return lerp(point, target, t);
}

function up(point: ScreenPt, amount: number): ScreenPt {
  return { x: point.x, y: point.y - amount };
}

function quadCenter(a: ScreenPt, b: ScreenPt, c: ScreenPt, d: ScreenPt): ScreenPt {
  return { x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 };
}
