import type { PrismColors } from '../palette.js';
import { seeded } from '../seed.js';
import { type PrismScreen, drawPrism, fillQuad } from './prism.js';
import { townRoofRiseIso } from './projection.js';
import type { IsoRenderState, ScreenPt } from './state.js';
import { type RidgeAxis, SEED_SALT, type TownStyle } from './town-style.js';

interface TownDrawOptions {
  compact?: boolean;
  suppressDetails?: boolean;
}

/** Projected width below which trim strokes stop resolving and become noise. */
const MIN_TRIM_PX = 20;

/**
 * Where a roof's ridge actually landed, in screen space.
 *
 * Roof furniture used to guess the ridge as `center.y - rise * 0.75`, which is
 * roughly right for a gable and wrong for everything else — hip ridges are
 * shorter, mansard ridges sit on an inset deck, and a pyramid has no ridge at
 * all. Each roof now reports its own, so chimneys, dormers, and caps sit on the
 * roof instead of near it.
 */
export interface RoofRidge {
  a: ScreenPt;
  b: ScreenPt;
  /** Highest drawn point — where a cap (cupola, tower, finial) mounts. */
  apex: ScreenPt;
}

/**
 * Total drawn height of each cap, per unit of its width/size argument. These
 * must track the draw functions below: `drawRoofFurniture` divides the
 * remaining headroom by them to pick a size that cannot overrun the budget.
 */
const CAP_HEIGHT = {
  // body 1.5w + spire 0.9w
  'clock-tower': 2.4,
  // body 0.85w + dome 0.65w + spike 0.33w
  cupola: 1.85,
  // box 0.7w + cap 0.1w + roof 0.55w
  lantern: 1.35,
  // post 1.0s + gable 0.5s
  bellcote: 1.5,
  finial: 1.05,
} as const;

/** Draw one code-generated isometric building in the 1890–1915 vocabulary. */
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

  // Trim runs one tier wider than the rest of the facade: a cornice is two
  // 1px lines, and it is most of what makes a core read as masonry at the zoom
  // where windows would be sub-pixel mush.
  //
  // Gated on projected width alone, NOT on `compact`. A symbol mini that is 60px
  // across earns its cornice exactly as a file building does; excluding minis
  // wholesale is what left symbol campuses — the bulk of any real codebase —
  // as untrimmed boxes.
  if (!options.suppressDetails && prism.te.x - prism.tw.x >= MIN_TRIM_PX) {
    drawTrim(ctx, s, prism, style, colors);
  }

  const ridge = drawRoof(ctx, s, prism, style, roofPx, colors);

  if (!options.suppressDetails && s.tier === 'street') {
    // Caps mount on the ridge and must fit in whatever headroom is left inside
    // the declared budget. Deriving their size from what remains — rather than
    // from the block's width — makes the roofFactor contract structural: a cap
    // physically cannot paint past the budget culling and hit-testing assume.
    const budgetPx = roofPx * (style.roofFactor ?? 1);
    const capHeadroom = Math.max(0, budgetPx - (prism.tn.y - ridge.apex.y));
    drawRoofFurniture(ctx, s, prism, style, ridge, roofPx, capHeadroom, compact);
  }
}

function drawRoof(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  p: PrismScreen,
  style: TownStyle,
  rise: number,
  c: PrismColors,
): RoofRidge {
  const r = style.ridge;
  switch (style.roof) {
    case 'gable':
      return drawGableRoof(ctx, p, r, rise, c);
    case 'hip':
      return drawHipRoof(ctx, p, r, rise, c);
    case 'mansard':
      return drawMansardRoof(ctx, p, r, rise, c);
    case 'sawtooth':
      return drawSawtoothRoof(ctx, p, r, rise, style.sawteeth, c);
    case 'shed':
      return drawShedRoof(ctx, p, r, rise, c);
    case 'thatch':
      return drawThatchRoof(ctx, p, r, rise, c);
    case 'half-hip':
      return drawHalfHipRoof(ctx, p, r, rise, c);
    case 'catslide':
      return drawCatslideRoof(ctx, p, r, rise, c);
    case 'parapet':
      return drawParapetRoof(ctx, p, rise, c);
    case 'monitor':
      return drawMonitorRoof(ctx, p, r, rise, c);
    case 'pyramid':
      return drawPyramidRoof(ctx, p, rise, c);
    case 'barrel':
      return drawBarrelRoof(ctx, s, p, r, rise, c);
    case 'conical':
      return drawConicalRoof(ctx, p, rise, c);
  }
}

/** The two eaves-line midpoints a ridge runs between, for a given axis. */
function eaveMids(p: PrismScreen, ridge: RidgeAxis): [ScreenPt, ScreenPt] {
  return ridge === 'x' ? [mid(p.tn, p.tw), mid(p.te, p.ts)] : [mid(p.tn, p.te), mid(p.tw, p.ts)];
}

function ridgeOf(a: ScreenPt, b: ScreenPt): RoofRidge {
  return { a, b, apex: mid(a, b) };
}

function drawGableRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): RoofRidge {
  if (ridge === 'x') {
    const a = up(mid(p.tn, p.tw), rise);
    const b = up(mid(p.te, p.ts), rise);
    fillTriangle(ctx, c.wallL, p.tn, p.tw, a);
    fillTriangle(ctx, c.wallR, p.te, b, p.ts);
    fillQuad(ctx, c.top, p.tn, p.te, b, a);
    fillQuad(ctx, c.wallL, a, b, p.ts, p.tw);
    strokeRidge(ctx, c.edge, a, b);
    return ridgeOf(a, b);
  }
  const a = up(mid(p.tn, p.te), rise);
  const b = up(mid(p.tw, p.ts), rise);
  fillTriangle(ctx, c.wallR, p.tn, a, p.te);
  fillTriangle(ctx, c.wallL, p.tw, p.ts, b);
  fillQuad(ctx, c.top, p.tn, a, b, p.tw);
  fillQuad(ctx, c.wallL, a, p.te, p.ts, b);
  strokeRidge(ctx, c.edge, a, b);
  return ridgeOf(a, b);
}

/**
 * Thatch — the village signature. Gable geometry, but the mass reads as
 * material rather than carpentry: a deep eave overhang below the eaves line and
 * a fat rounded ridge cap instead of a crisp 1px ridge.
 */
function drawThatchRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): RoofRidge {
  const r = drawGableRoof(ctx, p, ridge, rise * 1.12, c);
  // Overhanging eave: a shallow band hanging past the wall head on both slopes.
  const drop = Math.max(1.2, rise * 0.16);
  ctx.fillStyle = c.wallR;
  ctx.globalAlpha = 0.55;
  for (const [q0, q1] of ridge === 'x'
    ? ([
        [p.tn, p.te],
        [p.tw, p.ts],
      ] as const)
    : ([
        [p.tn, p.tw],
        [p.te, p.ts],
      ] as const)) {
    path(ctx, [q0, q1, { x: q1.x, y: q1.y + drop }, { x: q0.x, y: q0.y + drop }], true);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Rounded ridge cap.
  ctx.strokeStyle = c.top;
  ctx.lineWidth = Math.max(1.5, rise * 0.22);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(r.a.x, r.a.y);
  ctx.lineTo(r.b.x, r.b.y);
  ctx.stroke();
  ctx.lineCap = 'butt';
  return r;
}

/** Jerkinhead: a gable whose apex is clipped back into a small hip. */
function drawHalfHipRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): RoofRidge {
  const [m0, m1] = eaveMids(p, ridge);
  const a = up(lerp(m0, m1, 0.12), rise);
  const b = up(lerp(m0, m1, 0.88), rise);
  // Two-thirds-height eave corners give the clipped hip its short end slope.
  const k = 0.66;
  if (ridge === 'x') {
    const na = up(mid(p.tn, p.tw), rise * k);
    const nb = up(mid(p.te, p.ts), rise * k);
    fillQuad(ctx, c.wallL, p.tn, p.tw, na, a);
    fillQuad(ctx, c.wallR, p.te, b, nb, p.ts);
    fillQuad(ctx, c.top, p.tn, p.te, b, a);
    fillQuad(ctx, c.wallL, a, b, p.ts, p.tw);
  } else {
    const na = up(mid(p.tn, p.te), rise * k);
    const nb = up(mid(p.tw, p.ts), rise * k);
    fillQuad(ctx, c.wallR, p.tn, a, na, p.te);
    fillQuad(ctx, c.wallL, p.tw, p.ts, nb, b);
    fillQuad(ctx, c.top, p.tn, a, b, p.tw);
    fillQuad(ctx, c.wallL, a, p.te, p.ts, b);
  }
  strokeRidge(ctx, c.edge, a, b);
  return ridgeOf(a, b);
}

/** Catslide: asymmetric gable, one plane running long to a lower eave — the
 *  outshot at the back of a farmhouse. */
function drawCatslideRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): RoofRidge {
  // Ridge pushed off-center toward the short slope.
  const t = 0.34;
  if (ridge === 'x') {
    const a = up(lerp(p.tw, p.tn, t), rise);
    const b = up(lerp(p.ts, p.te, t), rise);
    fillTriangle(ctx, c.wallL, p.tn, p.tw, a);
    fillTriangle(ctx, c.wallR, p.te, b, p.ts);
    fillQuad(ctx, c.top, p.tn, p.te, b, a);
    fillQuad(ctx, c.wallL, a, b, p.ts, p.tw);
    strokeRidge(ctx, c.edge, a, b);
    return ridgeOf(a, b);
  }
  const a = up(lerp(p.te, p.tn, t), rise);
  const b = up(lerp(p.ts, p.tw, t), rise);
  fillTriangle(ctx, c.wallR, p.tn, a, p.te);
  fillTriangle(ctx, c.wallL, p.tw, p.ts, b);
  fillQuad(ctx, c.top, p.tn, a, b, p.tw);
  fillQuad(ctx, c.wallL, a, p.te, p.ts, b);
  strokeRidge(ctx, c.edge, a, b);
  return ridgeOf(a, b);
}

function drawHipRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): RoofRidge {
  const [rawA, rawB] = eaveMids(p, ridge);
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
  return ridgeOf(a, b);
}

function drawMansardRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): RoofRidge {
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
  // The ridge of a mansard is its inset deck, not a line at the wall head.
  return ridge === 'x' ? ridgeOf(mid(n, w), mid(e, s)) : ridgeOf(mid(n, e), mid(w, s));
}

function drawSawtoothRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  requested: number,
  c: PrismColors,
): RoofRidge {
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
  // Report the first sawtooth's peak: it's where a stack would stand.
  const ra = up(lerp(a0, a1, 0.68 / count), rise * 0.72);
  const rb = up(lerp(b0, b1, 0.68 / count), rise * 0.72);
  return ridgeOf(ra, rb);
}

function drawShedRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): RoofRidge {
  if (ridge === 'x') {
    const n = up(p.tn, rise);
    const e = up(p.te, rise);
    fillTriangle(ctx, c.wallL, p.tn, p.tw, n);
    fillTriangle(ctx, c.wallR, p.te, e, p.ts);
    fillQuad(ctx, c.top, n, e, p.ts, p.tw);
    strokeRidge(ctx, c.edge, n, e);
    return ridgeOf(n, e);
  }
  const n = up(p.tn, rise);
  const w = up(p.tw, rise);
  fillTriangle(ctx, c.wallR, p.tn, n, p.te);
  fillTriangle(ctx, c.wallL, p.tw, p.ts, w);
  fillQuad(ctx, c.top, n, p.te, p.ts, w);
  strokeRidge(ctx, c.edge, n, w);
  return ridgeOf(n, w);
}

/**
 * Parapet — the city signature. A flat deck sunk behind a raised masonry rim,
 * which is what makes a commercial terrace read as urban at district zoom where
 * a pitched roof would read as a house.
 */
function drawParapetRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  rise: number,
  c: PrismColors,
): RoofRidge {
  const wallH = Math.max(1.5, rise * 0.42);
  const n = up(p.tn, wallH);
  const e = up(p.te, wallH);
  const st = up(p.ts, wallH);
  const w = up(p.tw, wallH);
  // Rim: the two visible outer faces, then the capped top ring.
  fillQuad(ctx, c.wallL, w, st, p.ts, p.tw);
  fillQuad(ctx, c.wallR, st, e, p.te, p.ts);
  fillQuad(ctx, c.top, n, e, st, w);
  // Sunk deck, a step darker so the rim reads as standing proud of it.
  const center = quadCenter(n, e, st, w);
  const deck: [ScreenPt, ScreenPt, ScreenPt, ScreenPt] = [
    lerp(n, center, 0.2),
    lerp(e, center, 0.2),
    lerp(st, center, 0.2),
    lerp(w, center, 0.2),
  ];
  fillQuad(ctx, c.wallL, ...deck);
  ctx.strokeStyle = c.edge;
  ctx.lineWidth = 0.8;
  path(ctx, [n, e, st, w], true);
  ctx.stroke();
  return ridgeOf(deck[0], deck[2]);
}

/** Monitor: a long pitched roof with a raised clerestory box along the ridge —
 *  mills, warehouses, and market halls that needed daylight. */
function drawMonitorRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): RoofRidge {
  const base = drawGableRoof(ctx, p, ridge, rise * 0.6, c);
  const lift = rise * 0.42;
  const halfW = Math.abs(p.te.x - p.tw.x) * 0.1;
  const a0 = { x: base.a.x + halfW * 0.35, y: base.a.y };
  const b0 = { x: base.b.x - halfW * 0.35, y: base.b.y };
  const a1 = up(a0, lift);
  const b1 = up(b0, lift);
  fillQuad(ctx, c.wallR, a0, b0, b1, a1);
  fillQuad(ctx, c.top, a1, b1, up(b1, 1.5), up(a1, 1.5));
  strokeRidge(ctx, c.edge, up(a1, 1.5), up(b1, 1.5));
  return ridgeOf(up(a1, 1.5), up(b1, 1.5));
}

/** Pyramid: a square hip to a point — market crosses, turrets, kiosks. */
function drawPyramidRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  rise: number,
  c: PrismColors,
): RoofRidge {
  const apex = up(quadCenter(p.tn, p.te, p.ts, p.tw), rise * 1.35);
  fillTriangle(ctx, c.top, p.tw, p.tn, apex);
  fillTriangle(ctx, c.top, p.tn, p.te, apex);
  fillTriangle(ctx, c.wallL, p.tw, apex, p.ts);
  fillTriangle(ctx, c.wallR, p.ts, apex, p.te);
  strokeRidge(ctx, c.edge, p.tn, apex, 0.7);
  return { a: apex, b: apex, apex };
}

/** Barrel: an arched glazed span, drawn as three flat tone bands rather than a
 *  gradient — arcades and rail termini. */
function drawBarrelRoof(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  p: PrismScreen,
  ridge: RidgeAxis,
  rise: number,
  c: PrismColors,
): RoofRidge {
  const [m0, m1] = eaveMids(p, ridge);
  const [q0, q1, q2, q3] = ridge === 'x' ? [p.tn, p.te, p.ts, p.tw] : [p.te, p.ts, p.tw, p.tn];
  const crownA = up(m0, rise);
  const crownB = up(m1, rise);
  // Three bands: the far slope, the crown, and the near slope. Widths chosen so
  // the crown band reads as the top of an arch rather than a flat ridge.
  const midFarA = up(lerp(q3, m0, 0.5), rise * 0.86);
  const midFarB = up(lerp(q2, m1, 0.5), rise * 0.86);
  const midNearA = up(lerp(q0, m0, 0.5), rise * 0.86);
  const midNearB = up(lerp(q1, m1, 0.5), rise * 0.86);
  fillQuad(ctx, c.wallL, q3, q2, midFarB, midFarA);
  fillQuad(ctx, c.top, midFarA, midFarB, crownB, crownA);
  fillQuad(ctx, s.palette.windowLit, crownA, crownB, midNearB, midNearA);
  fillQuad(ctx, c.wallR, midNearA, midNearB, q1, q0);
  strokeRidge(ctx, c.edge, crownA, crownB, 0.7);
  return ridgeOf(crownA, crownB);
}

/** Conical: a bottle kiln / oast cone. Declares `roofFactor` in the spec so its
 *  extra height stays inside the culling and hit-test budget. */
function drawConicalRoof(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  rise: number,
  c: PrismColors,
): RoofRidge {
  const center = quadCenter(p.tn, p.te, p.ts, p.tw);
  const apex = up(center, rise * 2.1);
  // Waist, so the cone bellies out like brickwork instead of reading as a spike.
  const waist = 0.42;
  const wn = up(lerp(p.tn, center, waist), rise * 1.05);
  const we = up(lerp(p.te, center, waist), rise * 1.05);
  const ws = up(lerp(p.ts, center, waist), rise * 1.05);
  const ww = up(lerp(p.tw, center, waist), rise * 1.05);
  fillQuad(ctx, c.top, p.tn, p.te, we, wn);
  fillQuad(ctx, c.wallR, p.te, p.ts, ws, we);
  fillQuad(ctx, c.wallL, ww, ws, p.ts, p.tw);
  fillQuad(ctx, c.top, p.tn, wn, ww, p.tw);
  fillTriangle(ctx, c.top, wn, we, apex);
  fillTriangle(ctx, c.wallR, we, ws, apex);
  fillTriangle(ctx, c.wallL, ws, ww, apex);
  fillTriangle(ctx, c.top, ww, wn, apex);
  return { a: apex, b: apex, apex };
}

function drawFacadeDetails(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  p: PrismScreen,
  style: TownStyle,
  compact: boolean,
): void {
  const random = seeded(style.seed ^ SEED_SALT.FACADE);
  const rows = Math.max(1, Math.min(3, style.storeys));
  const bays = Math.max(1, Math.min(compact ? 3 : 4, style.bays));
  const windowColor = () => (random() < 0.24 ? s.palette.windowLit : s.palette.window);

  drawWallWindows(ctx, p.tw, p.ts, p.gw, p.gs, rows, bays, windowColor);
  drawWallWindows(ctx, p.ts, p.te, p.gs, p.ge, rows, Math.max(1, bays - 1), windowColor);

  drawGroundFloor(ctx, s, p, style);

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

/**
 * The ground storey — the strongest "what is this building for" cue the facade
 * has. A shopfront and a cart door read differently from thirty feet away in a
 * way that a roof pitch never will.
 *
 * Everything here paints on the S and E walls (`ts→te`), the two facing the
 * camera, so nothing can be overpainted by the building's own geometry.
 */
function drawGroundFloor(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  p: PrismScreen,
  style: TownStyle,
): void {
  const wall = (u0: number, u1: number, v0: number, v1: number) =>
    wallPatch(p.ts, p.te, p.gs, p.ge, u0, u1, v0, v1);
  const at = (u: number, v: number) => wall(u, u, v, v)[0];

  switch (style.ground) {
    case 'shopfront': {
      // Wide glazing over a stallriser, with two mullions.
      fillQuad(ctx, s.palette.windowLit, ...wall(0.06, 0.94, 0.6, 0.88));
      fillQuad(ctx, s.palette.masonry, ...wall(0.06, 0.94, 0.88, 0.98));
      ctx.strokeStyle = s.palette.masonry;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const u of [0.36, 0.64]) {
        const a = at(u, 0.6);
        const b = at(u, 0.88);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      break;
    }
    case 'arcade': {
      // A run of open bays: alternating dark voids and pier slivers.
      const bays = Math.max(2, Math.min(4, style.bays));
      for (let i = 0; i < bays; i++) {
        const span = 0.88 / bays;
        const u0 = 0.06 + i * span + span * 0.16;
        const u1 = 0.06 + (i + 1) * span - span * 0.16;
        fillQuad(ctx, s.palette.window, ...wall(u0, u1, 0.58, 0.98));
      }
      break;
    }
    case 'cart-door': {
      // One tall opening filling most of the ground storey.
      fillQuad(ctx, s.palette.window, ...wall(0.24, 0.74, 0.5, 0.98));
      ctx.strokeStyle = s.palette.masonry;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(at(0.24, 0.5).x, at(0.24, 0.5).y);
      ctx.lineTo(at(0.74, 0.5).x, at(0.74, 0.5).y);
      ctx.stroke();
      break;
    }
    case 'portico': {
      // Columns and a pediment — the civic front.
      for (const u of [0.2, 0.42, 0.64]) {
        fillQuad(ctx, s.palette.sidewalk, ...wall(u, u + 0.08, 0.55, 0.98));
      }
      const ped = wall(0.14, 0.78, 0.44, 0.55);
      fillQuad(ctx, s.palette.sidewalk, ...ped);
      ctx.strokeStyle = s.palette.masonry;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(ped[0].x, ped[0].y);
      ctx.lineTo(ped[1].x, ped[1].y);
      ctx.stroke();
      break;
    }
    default:
      // A dark, narrow door keeps the little structures from reading as
      // decorated blocks rather than inhabited buildings.
      fillQuad(ctx, s.palette.window, ...wall(0.12, 0.3, 0.58, 0.98));
      break;
  }
}

/**
 * Masonry trim: cornice, string courses, parapet line, quoins.
 *
 * The best value-per-op in the whole vocabulary. Two 1px strokes turn a bare
 * prism into a masonry building, and unlike windows they stay legible at
 * *district* zoom — which is where the difference between a village lane and a
 * city core actually has to read.
 */
export function drawTrim(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  p: PrismScreen,
  style: TownStyle,
  colors: PrismColors,
): void {
  const t = style.trim;
  if (!t.cornice && !t.stringCourse && !t.parapet && !t.quoins) return;

  const band = (v: number, color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    // Both facing walls in one path, so a whole frame of trim is two strokes.
    ctx.beginPath();
    for (const [ta, tb, ga, gb] of [
      [p.tw, p.ts, p.gw, p.gs],
      [p.ts, p.te, p.gs, p.ge],
    ] as const) {
      const q = wallPatch(ta, tb, ga, gb, 0, 1, v, v);
      ctx.moveTo(q[0].x, q[0].y);
      ctx.lineTo(q[1].x, q[1].y);
    }
    ctx.stroke();
  };

  if (t.cornice) band(0.06, colors.edge, 1.1);
  if (t.parapet) band(0.14, colors.edge, 0.7);
  if (t.stringCourse && style.storeys >= 3) {
    const rows = Math.min(3, style.storeys - 1);
    for (let i = 1; i <= rows; i++) band(0.12 + (i * 0.74) / (rows + 1), colors.wallR, 0.7);
  }
  if (t.quoins) {
    // A stack of alternating blocks up the near corner.
    ctx.fillStyle = colors.edge;
    ctx.globalAlpha = 0.7;
    for (let i = 0; i < 4; i++) {
      const v0 = 0.12 + i * 0.2;
      fillQuad(ctx, colors.edge, ...wallPatch(p.ts, p.te, p.gs, p.ge, 0, 0.07, v0, v0 + 0.1));
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
  ridge: RoofRidge,
  roofRise: number,
  capHeadroom: number,
  compact: boolean,
): void {
  const random = seeded(style.seed ^ SEED_SALT.ROOF_FURNITURE);
  const scale = compact ? 0.65 : 1;
  /** Largest cap of total height `heightPerUnit × u` that still fits. */
  const fit = (want: number, heightPerUnit: number): number =>
    Math.max(0, Math.min(want, capHeadroom / heightPerUnit));

  // Stacks ride the reported ridge rather than a guess at where it might be, so
  // they land on hip, mansard, and sawtooth roofs as squarely as on a gable.
  for (let i = 0; i < style.chimneys; i++) {
    const t = style.chimneys === 1 ? 0.5 : 0.27 + (i / (style.chimneys - 1)) * 0.46;
    const at = lerp(ridge.a, ridge.b, t);
    const x = at.x + (random() - 0.5) * 2;
    drawStack(ctx, x, at.y, Math.max(1.5, 2.7 * scale), Math.max(4, 7 * scale), s.palette.masonry);
  }

  if (style.cupola && style.cap !== 'clock-tower') {
    const width = fit(Math.min(13, (p.te.x - p.tw.x) * 0.15), CAP_HEIGHT.cupola);
    if (width >= 3) drawCupola(ctx, ridge.apex.x, ridge.apex.y, width, style.clock, s);
  }

  switch (style.cap) {
    case 'bellcote': {
      const size = fit(7 * scale, CAP_HEIGHT.bellcote);
      if (size >= 2.5) drawBellcote(ctx, ridge.a, size, s);
      break;
    }
    case 'finial': {
      const size = fit(6 * scale, CAP_HEIGHT.finial);
      if (size >= 2) drawFinial(ctx, ridge.a, size, s.palette.masonry);
      break;
    }
    case 'clock-tower': {
      const width = fit((p.te.x - p.tw.x) * 0.16, CAP_HEIGHT['clock-tower']);
      if (width >= 3) drawClockTower(ctx, ridge.apex, width, s);
      break;
    }
    case 'lantern': {
      const width = fit(8 * scale, CAP_HEIGHT.lantern);
      if (width >= 3) drawLantern(ctx, ridge.apex, width, s);
      break;
    }
    default:
      break;
  }

  if (style.dormers > 0 && p.te.x - p.tw.x >= 28) {
    const count = Math.min(3, style.dormers);
    for (let i = 0; i < count; i++) {
      // Dormers sit on the slope: partway down from the ridge toward the eave.
      const at = lerp(ridge.a, ridge.b, count === 1 ? 0.5 : 0.25 + (i / (count - 1)) * 0.5);
      const y = at.y + roofRise * 0.45;
      drawDormer(ctx, at.x, y, s.palette.window, s.palette.masonry);
    }
  }
}

/** A small open bell housing at the gable end — chapels and schoolhouses. */
function drawBellcote(
  ctx: CanvasRenderingContext2D,
  at: ScreenPt,
  size: number,
  s: IsoRenderState,
): void {
  const half = size * 0.32;
  ctx.fillStyle = s.palette.masonry;
  ctx.fillRect(at.x - half, at.y - size, half * 2, size);
  fillTriangle(
    ctx,
    s.palette.domeAccent,
    { x: at.x - half * 1.3, y: at.y - size },
    { x: at.x, y: at.y - size * 1.5 },
    { x: at.x + half * 1.3, y: at.y - size },
  );
  ctx.fillStyle = s.palette.window;
  ctx.fillRect(at.x - half * 0.45, at.y - size * 0.8, half * 0.9, size * 0.5);
}

/** A ridge-end spike or weathervane — the village's quiet flourish. */
function drawFinial(
  ctx: CanvasRenderingContext2D,
  at: ScreenPt,
  size: number,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(at.x, at.y - size);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillRect(at.x - size * 0.28, at.y - size, size * 0.56, 1.2);
}

/** The city landmark's clock tower. Its extra height is declared by the
 *  archetype's `roofFactor`, so culling and hit-testing already account for it. */
function drawClockTower(
  ctx: CanvasRenderingContext2D,
  at: ScreenPt,
  width: number,
  s: IsoRenderState,
): void {
  const half = width / 2;
  const bodyH = width * 1.5;
  const top = at.y - bodyH;
  ctx.fillStyle = s.palette.sidewalk;
  ctx.fillRect(at.x - half, top, width, bodyH);
  ctx.fillStyle = s.palette.masonry;
  ctx.globalAlpha = 0.6;
  ctx.fillRect(at.x, top, half, bodyH);
  ctx.globalAlpha = 1;
  fillTriangle(
    ctx,
    s.palette.domeAccent,
    { x: at.x - half * 1.2, y: top },
    { x: at.x, y: top - width * 0.9 },
    { x: at.x + half * 1.2, y: top },
  );
  ctx.fillStyle = s.palette.windowLit;
  ctx.beginPath();
  ctx.arc(at.x, top + bodyH * 0.34, Math.max(1.6, width * 0.22), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = s.palette.window;
  ctx.lineWidth = 0.7;
  ctx.stroke();
}

/** A glazed roof lantern — grand hotels and institutes. */
function drawLantern(
  ctx: CanvasRenderingContext2D,
  at: ScreenPt,
  width: number,
  s: IsoRenderState,
): void {
  const half = width / 2;
  const h = width * 0.7;
  ctx.fillStyle = s.palette.windowLit;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(at.x - half, at.y - h, width, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = s.palette.masonry;
  ctx.fillRect(at.x - half, at.y - h - 1.4, width, 1.4);
  fillTriangle(
    ctx,
    s.palette.domeAccent,
    { x: at.x - half, y: at.y - h - 1.4 },
    { x: at.x, y: at.y - h - width * 0.55 },
    { x: at.x + half, y: at.y - h - 1.4 },
  );
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
