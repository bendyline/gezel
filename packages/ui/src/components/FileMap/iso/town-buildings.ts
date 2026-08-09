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
    drawRoofMaterial(ctx, prism, style, ridge, colors, compact);
    drawEavesAndBargeboards(ctx, prism, style, ridge, colors, compact);

    // Caps mount on the ridge and must fit in whatever headroom is left inside
    // the declared budget. Deriving their size from what remains — rather than
    // from the block's width — makes the roofFactor contract structural: a cap
    // physically cannot paint past the budget culling and hit-testing assume.
    const budgetPx = roofPx * (style.roofFactor ?? 1);
    // Measured from the HIGHEST mount point, not the apex: a bellcote and a
    // finial sit on `ridge.a`, which on a gable stands above the midpoint the
    // apex reports. Budgeting against the apex let those caps overrun.
    const mountY = Math.min(ridge.a.y, ridge.b.y, ridge.apex.y);
    const capHeadroom = Math.max(0, budgetPx - (prism.tn.y - mountY));
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

interface RoofPlane {
  ridgeA: ScreenPt;
  ridgeB: ScreenPt;
  eaveA: ScreenPt;
  eaveB: ScreenPt;
}

/** The two long planes of a pitched roof, expressed from ridge to eave. */
function roofPlanes(p: PrismScreen, ridge: RoofRidge, axis: RidgeAxis): RoofPlane[] {
  return axis === 'x'
    ? [
        { ridgeA: ridge.a, ridgeB: ridge.b, eaveA: p.tn, eaveB: p.te },
        { ridgeA: ridge.a, ridgeB: ridge.b, eaveA: p.tw, eaveB: p.ts },
      ]
    : [
        { ridgeA: ridge.a, ridgeB: ridge.b, eaveA: p.tn, eaveB: p.tw },
        { ridgeA: ridge.a, ridgeB: ridge.b, eaveA: p.te, eaveB: p.ts },
      ];
}

/**
 * Slate courses, tile joints, thatch strokes, and industrial roof seams.
 *
 * The marks are interpolated inside each projected roof plane, so they remain
 * crisp vector linework through zooming and HiDPI rendering. This is the useful
 * kind of texture here: it describes how a roof is assembled without adding a
 * repeating bitmap that swims when the camera moves.
 */
function drawRoofMaterial(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  style: TownStyle,
  ridge: RoofRidge,
  colors: PrismColors,
  compact: boolean,
): void {
  const widthPx = p.te.x - p.tw.x;
  if (widthPx < (compact ? 24 : 30)) return;
  if (
    style.roof === 'sawtooth' ||
    style.roof === 'monitor' ||
    style.roof === 'pyramid' ||
    style.roof === 'barrel' ||
    style.roof === 'conical' ||
    style.roof === 'parapet'
  ) {
    return;
  }

  const planes = roofPlanes(p, ridge, style.ridge);
  const material = style.roof === 'thatch' ? 'thatch' : style.material.roof;
  const line = (a: ScreenPt, b: ScreenPt) => {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  };

  ctx.strokeStyle = colors.wallR;
  ctx.lineWidth = material === 'iron' ? 0.75 : 0.6;
  ctx.globalAlpha = material === 'thatch' ? 0.34 : 0.26;
  ctx.beginPath();

  for (const plane of planes) {
    if (material === 'slate' || material === 'tile') {
      const courses = material === 'slate' ? [0.28, 0.48, 0.66, 0.82] : [0.34, 0.6, 0.82];
      let previous = 0.08;
      for (let row = 0; row < courses.length; row++) {
        const t = courses[row]!;
        line(lerp(plane.ridgeA, plane.eaveA, t), lerp(plane.ridgeB, plane.eaveB, t));
        if (widthPx >= 38) {
          // Staggered vertical joints keep the courses from becoming stripes.
          const count = compact ? 3 : 5;
          for (let i = 1; i < count; i++) {
            const u = (i + (row % 2 === 0 ? 0.28 : -0.18)) / count;
            if (u <= 0 || u >= 1) continue;
            const onRidge = lerp(plane.ridgeA, plane.ridgeB, u);
            const onEave = lerp(plane.eaveA, plane.eaveB, u);
            line(lerp(onRidge, onEave, previous), lerp(onRidge, onEave, t));
          }
        }
        previous = t;
      }
    } else if (material === 'thatch') {
      const count = compact ? 4 : 7;
      for (let i = 1; i < count; i++) {
        const u = i / count;
        const onRidge = lerp(plane.ridgeA, plane.ridgeB, u);
        const onEave = lerp(plane.eaveA, plane.eaveB, u);
        line(lerp(onRidge, onEave, 0.12), lerp(onRidge, onEave, 0.94));
      }
    } else if (material === 'iron' || material === 'glass') {
      const count = compact ? 4 : 7;
      for (let i = 1; i < count; i++) {
        const u = i / count;
        line(lerp(plane.ridgeA, plane.ridgeB, u), lerp(plane.eaveA, plane.eaveB, u));
      }
      if (material === 'glass') {
        line(lerp(plane.ridgeA, plane.eaveA, 0.55), lerp(plane.ridgeB, plane.eaveB, 0.55));
      }
    }
  }

  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * A roof should visibly project past its wall. The heavy lower line is the
 * eaves shadow; the light line above is the fascia/bargeboard catching the NW
 * light. Even at campus scale this turns a lid-on-a-box into carpentry.
 */
function drawEavesAndBargeboards(
  ctx: CanvasRenderingContext2D,
  p: PrismScreen,
  style: TownStyle,
  ridge: RoofRidge,
  colors: PrismColors,
  compact: boolean,
): void {
  if (style.roof === 'parapet' || style.roof === 'conical' || style.roof === 'pyramid') return;
  const widthPx = p.te.x - p.tw.x;
  const weight = Math.max(1, Math.min(compact ? 1.7 : 2.2, widthPx * 0.024));

  ctx.strokeStyle = colors.wallR;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = weight + 0.8;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(p.tw.x, p.tw.y + 1);
  ctx.lineTo(p.ts.x, p.ts.y + 1);
  ctx.lineTo(p.te.x, p.te.y + 1);
  ctx.stroke();

  ctx.strokeStyle = colors.edge;
  ctx.globalAlpha = 0.72;
  ctx.lineWidth = weight;
  ctx.beginPath();
  ctx.moveTo(p.tw.x, p.tw.y);
  ctx.lineTo(p.ts.x, p.ts.y);
  ctx.lineTo(p.te.x, p.te.y);

  if (
    style.roof === 'gable' ||
    style.roof === 'thatch' ||
    style.roof === 'catslide' ||
    style.roof === 'half-hip'
  ) {
    // The near gable gets a bright V-shaped bargeboard.
    if (style.ridge === 'x') {
      ctx.moveTo(p.te.x, p.te.y);
      ctx.lineTo(ridge.b.x, ridge.b.y);
      ctx.lineTo(p.ts.x, p.ts.y);
    } else {
      ctx.moveTo(p.tw.x, p.tw.y);
      ctx.lineTo(ridge.b.x, ridge.b.y);
      ctx.lineTo(p.ts.x, p.ts.y);
    }
  }
  ctx.stroke();
  ctx.lineJoin = 'miter';
  ctx.globalAlpha = 1;
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

/** Projected wall width below which the fine facade layer stops resolving. */
const MIN_FINE_PX = 34;

/**
 * One visible wall, as the four corners `wallPatch` interpolates between.
 * Only the S and E walls face the camera; the others are never painted.
 */
interface WallQuad {
  ta: ScreenPt;
  tb: ScreenPt;
  ga: ScreenPt;
  gb: ScreenPt;
}

/**
 * Procedural wall grain, drawn in facade-relative coordinates.
 *
 * These are construction marks, not a bitmap pasted over the building: brick
 * courses follow the wall, weatherboards meet the corners, and ashlar joints
 * stagger. That keeps the linework sharp at every device scale and costs no
 * image fetches or texture atlas memory. It is deliberately street-tier only;
 * below 34px the same marks turn into moire and make a campus less legible.
 */
function drawWallMaterial(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  w: WallQuad,
  style: TownStyle,
  fine: boolean,
  side: number,
): void {
  if (!fine) return;
  const patch = (u0: number, u1: number, v0: number, v1: number) =>
    wallPatch(w.ta, w.tb, w.ga, w.gb, u0, u1, v0, v1);
  const line = (u0: number, v0: number, u1: number, v1: number) => {
    const a = patch(u0, u0, v0, v0)[0];
    const b = patch(u1, u1, v1, v1)[0];
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  };
  const random = seeded(style.seed ^ 0x4f1bbcdc ^ (side * 0x9e3779b9));

  ctx.strokeStyle = s.palette.masonry;
  ctx.lineWidth = 0.55;
  ctx.globalAlpha = s.palette.dark ? 0.3 : 0.22;
  ctx.beginPath();

  switch (style.material.wall) {
    case 'brick': {
      const courses = 6;
      for (let row = 1; row <= courses; row++) {
        const v = 0.08 + (row * 0.86) / (courses + 1);
        line(0.02, v, 0.98, v);
        // Two restrained head joints per course are enough to read as brick;
        // drawing every brick at map scale becomes a checkerboard.
        const offset = row % 2 === 0 ? 0.2 : 0.36;
        for (let u = offset; u < 0.96; u += 0.42) {
          const half = 0.86 / (courses + 1) / 2;
          line(u, v - half, u, v + half);
        }
      }
      break;
    }
    case 'stone': {
      const courses = 4;
      for (let row = 1; row <= courses; row++) {
        const v = 0.1 + (row * 0.82) / (courses + 1);
        line(0.02, v, 0.98, v);
        const jointA = 0.18 + random() * 0.22;
        const jointB = 0.58 + random() * 0.24;
        const half = 0.82 / (courses + 1) / 2;
        line(jointA, v - half, jointA, v + half);
        line(jointB, v - half, jointB, v + half);
      }
      break;
    }
    case 'timber': {
      // Narrow painted weatherboards are a much stronger 1900–1915 cue than a
      // flat brown wall. The heavier framing for farm/service buildings is
      // layered separately by drawWallStructure.
      for (let i = 1; i <= 7; i++) {
        const v = 0.06 + (i * 0.88) / 8;
        line(0.02, v, 0.98, v);
      }
      break;
    }
    case 'stucco': {
      // Sparse trowel/scuff marks keep limewash from looking like plastic while
      // preserving the calm plane that distinguishes it from masonry.
      for (let i = 0; i < 6; i++) {
        const u = 0.1 + random() * 0.76;
        const v = 0.12 + random() * 0.72;
        line(u, v, Math.min(0.94, u + 0.06 + random() * 0.08), v + (random() - 0.5) * 0.03);
      }
      break;
    }
    case 'iron':
    case 'glass': {
      for (let i = 1; i <= 6; i++) {
        const u = i / 7;
        line(u, 0.05, u, 0.95);
      }
      break;
    }
    default:
      break;
  }

  ctx.stroke();
  ctx.globalAlpha = 1;
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
  const widthPx = p.te.x - p.tw.x;
  const fine = widthPx >= MIN_FINE_PX;

  const walls: Array<{ q: WallQuad; bays: number }> = [
    { q: { ta: p.tw, tb: p.ts, ga: p.gw, gb: p.gs }, bays },
    { q: { ta: p.ts, tb: p.te, ga: p.gs, gb: p.ge }, bays: Math.max(1, bays - 1) },
  ];

  for (let side = 0; side < walls.length; side++) {
    const { q, bays: n } = walls[side]!;
    drawWallMaterial(ctx, s, q, style, fine, side);
    drawWallStructure(ctx, s, q, style, fine, n);
    drawWallWindows(ctx, q, rows, n, fine, () =>
      random() < 0.24 ? s.palette.windowLit : s.palette.window,
    );
  }

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
      // Edwardian shopfront: a proper fascia, paired display panes, recessed
      // center door, transom, and masonry stallriser. The old uninterrupted
      // yellow strip was the single most modern-looking facade in the map.
      fillQuad(ctx, s.palette.sidewalk, ...wall(0.05, 0.95, 0.5, 0.59));
      fillQuad(ctx, s.palette.windowLit, ...wall(0.06, 0.43, 0.61, 0.88));
      fillQuad(ctx, s.palette.windowLit, ...wall(0.63, 0.94, 0.61, 0.88));
      fillQuad(ctx, s.palette.window, ...wall(0.46, 0.6, 0.64, 0.98));
      fillQuad(ctx, s.palette.windowLit, ...wall(0.46, 0.6, 0.59, 0.68));
      fillQuad(ctx, s.palette.masonry, ...wall(0.06, 0.94, 0.88, 0.98));
      ctx.strokeStyle = s.palette.masonry;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const u of [0.24, 0.43, 0.63, 0.79]) {
        const a = at(u, 0.61);
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
      const lt = at(0.24, 0.5);
      const rt = at(0.74, 0.5);
      const lb = at(0.24, 0.98);
      const rb = at(0.74, 0.98);
      ctx.moveTo(lt.x, lt.y);
      ctx.lineTo(rt.x, rt.y);
      ctx.moveTo(lt.x, lt.y);
      ctx.lineTo(rb.x, rb.y);
      ctx.moveTo(rt.x, rt.y);
      ctx.lineTo(lb.x, lb.y);
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
      const pedLeft = at(0.14, 0.44);
      const pedRight = at(0.78, 0.44);
      const pedCenter = mid(pedLeft, pedRight);
      fillTriangle(
        ctx,
        s.palette.sidewalk,
        pedLeft,
        { x: pedCenter.x, y: pedCenter.y - Math.max(2, (pedRight.x - pedLeft.x) * 0.08) },
        pedRight,
      );
      ctx.strokeStyle = s.palette.masonry;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(ped[0].x, ped[0].y);
      ctx.lineTo(ped[1].x, ped[1].y);
      ctx.stroke();
      break;
    }
    default: {
      // Framed paneled door, fanlight/transom, and a shallow stone stoop. The
      // entrance is intentionally narrow and tall — the previous dark slot was
      // proportioned like a service vent.
      fillQuad(ctx, s.palette.sidewalk, ...wall(0.09, 0.32, 0.54, 0.99));
      fillQuad(ctx, s.palette.window, ...wall(0.125, 0.285, 0.64, 0.99));
      fillQuad(ctx, s.palette.windowLit, ...wall(0.125, 0.285, 0.55, 0.65));
      ctx.strokeStyle = s.palette.masonry;
      ctx.globalAlpha = 0.72;
      ctx.lineWidth = 0.65;
      ctx.beginPath();
      const panelA = at(0.135, 0.82);
      const panelB = at(0.275, 0.82);
      ctx.moveTo(panelA.x, panelA.y);
      ctx.lineTo(panelB.x, panelB.y);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // The stoop projects into the yard in screen space, grounding the door.
      const stepA = at(0.075, 0.98);
      const stepB = at(0.335, 0.98);
      fillQuad(
        ctx,
        s.palette.sidewalk,
        stepA,
        stepB,
        { x: stepB.x + 1.2, y: stepB.y + 2.5 },
        { x: stepA.x + 1.2, y: stepA.y + 2.5 },
      );

      // Cottages and farmhouses earn a tiny bracketed porch hood once the
      // facade is wide enough to resolve it.
      if (
        p.te.x - p.tw.x >= 38 &&
        (style.archetype === 'cottage' ||
          style.archetype === 'farmhouse' ||
          style.archetype === 'cottage-row' ||
          style.archetype === 'boarding-house')
      ) {
        const hood = wall(0.055, 0.355, 0.47, 0.54);
        fillQuad(ctx, s.palette.masonry, ...hood);
        ctx.strokeStyle = s.palette.sidewalk;
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        for (const u of [0.08, 0.33]) {
          const top = at(u, 0.53);
          const foot = at(u, 0.96);
          ctx.moveTo(top.x, top.y);
          ctx.lineTo(foot.x, foot.y);
        }
        ctx.stroke();
      }
      break;
    }
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

/**
 * The wall itself, before anything is put in it: plinth, eaves fascia, storey
 * bands, bay pilasters, and half-timber framing.
 *
 * This layer is what turns a flat quad into a building. Without it a facade is
 * a colored box with window slits punched in, and the only thing separating one
 * building from the next is whether its lights happen to be on — which is
 * exactly how the settlement read before.
 *
 * Everything is expressed in wall-relative UV, so it scales with the building
 * instead of sitting at a fixed pixel size.
 */
function drawWallStructure(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  w: WallQuad,
  style: TownStyle,
  fine: boolean,
  bays: number,
): void {
  const patch = (u0: number, u1: number, v0: number, v1: number) =>
    wallPatch(w.ta, w.tb, w.ga, w.gb, u0, u1, v0, v1);

  // Plinth: the building meets the ground on a base course rather than just
  // stopping. Reads at any size and is the cheapest grounding cue there is.
  ctx.globalAlpha = 0.5;
  fillQuad(ctx, s.palette.masonry, ...patch(0, 1, 0.93, 1));
  ctx.globalAlpha = 1;

  // Eaves fascia: a light band at the wall head, separating wall from roof.
  ctx.globalAlpha = 0.45;
  fillQuad(ctx, s.palette.sidewalk, ...patch(0, 1, 0.02, 0.07));
  ctx.globalAlpha = 1;

  if (!fine) return;

  // Pilasters on the bay divisions give a facade vertical rhythm. Urban
  // buildings articulate; village ones only board their corners.
  const urban = style.band !== 'village';
  ctx.globalAlpha = 0.3;
  if (urban && bays > 1) {
    for (let i = 1; i < bays; i++) {
      const u = 0.09 + (0.82 * i) / bays;
      fillQuad(ctx, s.palette.sidewalk, ...patch(u - 0.012, u + 0.012, 0.07, 0.93));
    }
  }
  // Corner boards / quoin strips at both ends of every wall.
  fillQuad(ctx, s.palette.sidewalk, ...patch(0, 0.035, 0.07, 0.93));
  fillQuad(ctx, s.palette.sidewalk, ...patch(0.965, 1, 0.07, 0.93));
  ctx.globalAlpha = 1;

  // Exposed framing belongs on working/rural buildings; ordinary timber houses
  // get the weatherboards above instead. Putting posts on every cottage made
  // the settlement read Tudor rather than Edwardian.
  const framed =
    style.material.wall === 'timber' &&
    (style.archetype === 'farmhouse' ||
      style.archetype === 'barn' ||
      style.archetype === 'smithy' ||
      style.archetype === 'mill');
  if (framed) {
    ctx.strokeStyle = s.palette.masonry;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const rail = 0.5;
    const a = patch(0.03, 0.03, rail, rail)[0];
    const b = patch(0.97, 0.97, rail, rail)[0];
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    for (let i = 0; i <= bays; i++) {
      const u = 0.06 + (0.88 * i) / Math.max(1, bays);
      const t0 = patch(u, u, 0.08, 0.08)[0];
      const t1 = patch(u, u, 0.92, 0.92)[0];
      ctx.moveTo(t0.x, t0.y);
      ctx.lineTo(t1.x, t1.y);
    }
    // One diagonal brace in each bay keeps the frame structural rather than a
    // modern curtain-wall grid.
    for (let i = 0; i < bays; i++) {
      const u0 = 0.06 + (0.88 * i) / Math.max(1, bays);
      const u1 = 0.06 + (0.88 * (i + 1)) / Math.max(1, bays);
      const a = patch(u0, u0, 0.5, 0.5)[0];
      const b = patch(u1, u1, 0.88, 0.88)[0];
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/**
 * Windows with a lintel over and a sill under, plus glazing bars once they are
 * large enough to resolve.
 *
 * A bare rectangle reads as a slit; the same rectangle with a sill line under
 * it reads as a window, and that one extra quad is most of the difference
 * between "box with stripes" and "building".
 */
function drawWallWindows(
  ctx: CanvasRenderingContext2D,
  w: WallQuad,
  rows: number,
  bays: number,
  fine: boolean,
  color: () => string,
): void {
  const patch = (u0: number, u1: number, v0: number, v1: number) =>
    wallPatch(w.ta, w.tb, w.ga, w.gb, u0, u1, v0, v1);

  for (let row = 0; row < rows; row++) {
    const band = 0.72 / rows;
    const v0 = 0.12 + row * band;
    const v1 = Math.min(0.86, v0 + band * 0.58);
    for (let bay = 0; bay < bays; bay++) {
      const span = 0.82 / bays;
      // Tall, narrow sash proportions. The old 60%-of-bay opening read as a
      // horizontal strip once projected onto an isometric wall.
      const u0 = 0.09 + bay * span + span * 0.27;
      const u1 = 0.09 + (bay + 1) * span - span * 0.27;
      const glass = color();

      if (fine) {
        // Lintel above and sill below, the sill oversailing the reveal a little
        // so it catches as a shadow line.
        ctx.globalAlpha = 0.55;
        fillQuad(ctx, LINTEL, ...patch(u0 - 0.008, u1 + 0.008, v0 - 0.022, v0));
        ctx.globalAlpha = 0.8;
        fillQuad(ctx, SILL, ...patch(u0 - 0.016, u1 + 0.016, v1, v1 + 0.022));
        ctx.globalAlpha = 1;
      }

      fillQuad(ctx, glass, ...patch(u0, u1, v0, v1));

      if (fine) {
        // Glazing bars: one mullion, one transom. Turns a pane into a sash.
        ctx.strokeStyle = LINTEL;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        const um = (u0 + u1) / 2;
        const mt = patch(um, um, v0, v0)[0];
        const mb = patch(um, um, v1, v1)[0];
        ctx.moveTo(mt.x, mt.y);
        ctx.lineTo(mb.x, mb.y);
        const vt = v0 + (v1 - v0) * 0.42;
        const tl = patch(u0, u0, vt, vt)[0];
        const tr = patch(u1, u1, vt, vt)[0];
        ctx.moveTo(tl.x, tl.y);
        ctx.lineTo(tr.x, tr.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }
}

/** Stone dressings around an opening. Neutral on purpose — a sill is stone in
 *  every register, and tinting it per language would fight the roof field. */
const SILL = '#cfc6b4';
const LINTEL = '#3a342c';

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
  const widthPx = p.te.x - p.tw.x;
  /**
   * Furniture is sized as a FRACTION OF THE BUILDING, not in fixed screen
   * pixels. The old constants (a 2.7x7px stack) meant a chimney stayed a speck
   * however far you zoomed in — so at street zoom, where chimneys are exactly
   * the detail that says "1900s", every roof was bare.
   */
  const unit = Math.max(2, widthPx * (compact ? 0.055 : 0.07));
  /** Largest cap of total height `heightPerUnit × u` that still fits. */
  const fit = (want: number, heightPerUnit: number): number =>
    Math.max(0, Math.min(want, capHeadroom / heightPerUnit));

  // Stacks ride the reported ridge rather than a guess at where it might be, so
  // they land on hip, mansard, and sawtooth roofs as squarely as on a gable.
  for (let i = 0; i < style.chimneys; i++) {
    const t = style.chimneys === 1 ? 0.5 : 0.27 + (i / (style.chimneys - 1)) * 0.46;
    const at = lerp(ridge.a, ridge.b, t);
    const stackWidth = fit(unit, 1.9);
    if (stackWidth < 1.5) continue;
    const x = at.x + (random() - 0.5) * stackWidth * 0.6;
    drawStack(ctx, x, at.y, stackWidth, stackWidth * 1.9, s.palette.masonry);
  }

  if (style.cupola && style.cap !== 'clock-tower') {
    const width = fit(widthPx * 0.15, CAP_HEIGHT.cupola);
    if (width >= 3) drawCupola(ctx, ridge.apex.x, ridge.apex.y, width, style.clock, s);
  }

  switch (style.cap) {
    case 'bellcote': {
      const size = fit(unit * 2, CAP_HEIGHT.bellcote);
      if (size >= 2.5) drawBellcote(ctx, ridge.a, size, s);
      break;
    }
    case 'finial': {
      const size = fit(unit * 1.8, CAP_HEIGHT.finial);
      if (size >= 2) drawFinial(ctx, ridge.a, size, s.palette.masonry);
      break;
    }
    case 'clock-tower': {
      const width = fit((p.te.x - p.tw.x) * 0.16, CAP_HEIGHT['clock-tower']);
      if (width >= 3) drawClockTower(ctx, ridge.apex, width, s);
      break;
    }
    case 'lantern': {
      const width = fit(unit * 2.2, CAP_HEIGHT.lantern);
      if (width >= 3) drawLantern(ctx, ridge.apex, width, s);
      break;
    }
    default:
      break;
  }

  if (style.dormers > 0 && widthPx >= 28) {
    const count = Math.min(3, style.dormers);
    for (let i = 0; i < count; i++) {
      // Dormers sit on the slope: partway down from the ridge toward the eave.
      const at = lerp(ridge.a, ridge.b, count === 1 ? 0.5 : 0.25 + (i / (count - 1)) * 0.5);
      const y = at.y + roofRise * 0.45;
      // A dormer sits ON the slope and never breaks the ridge line, so its
      // size is bounded by the pitch it is set into, not just by the building
      // width. That is both the architecture and the roof-budget contract.
      const size = Math.min(unit * 0.9, roofRise * 0.28);
      if (size >= 2.4) drawDormer(ctx, at.x, y, size, s.palette.window, s.palette.masonry);
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
  const vaneY = at.y - size * 0.68;
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(at.x, at.y - size);
  ctx.moveTo(at.x - size * 0.2, vaneY);
  ctx.lineTo(at.x + size * 0.38, vaneY);
  ctx.stroke();
  fillTriangle(
    ctx,
    color,
    { x: at.x + size * 0.38, y: vaneY },
    { x: at.x + size * 0.18, y: vaneY - size * 0.12 },
    { x: at.x + size * 0.18, y: vaneY + size * 0.12 },
  );
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
  // Leave the 0.45px pot lip inside `height`; roof headroom is a hard culling
  // and hit-test contract, not merely a sizing hint.
  const top = y - height + 0.45;
  const potH = Math.max(0.8, width * 0.34);
  const bodyTop = top + potH;
  ctx.fillStyle = color;
  path(
    ctx,
    [
      { x: x - half, y: bodyTop },
      { x, y: bodyTop + half * 0.45 },
      { x, y: y + half * 0.45 },
      { x: x - half, y },
    ],
    true,
  );
  ctx.fill();
  ctx.globalAlpha = 0.72;
  path(
    ctx,
    [
      { x, y: bodyTop + half * 0.45 },
      { x: x + half, y: bodyTop },
      { x: x + half, y },
      { x, y: y + half * 0.45 },
    ],
    true,
  );
  ctx.fill();
  ctx.globalAlpha = 1;
  // Oversailing cap plus one or two terracotta chimney pots. Their upward
  // silhouette is the period cue; the previous implementation grew the whole
  // stack downward from the ridge and looked like a post driven into the roof.
  ctx.fillStyle = LINTEL;
  ctx.fillRect(x - half - 0.5, bodyTop - 1, width + 1, Math.max(1, width * 0.16));
  const pots = width >= 4.5 ? 2 : 1;
  const potW = Math.max(0.8, width * (pots === 2 ? 0.27 : 0.34));
  for (let i = 0; i < pots; i++) {
    const px = pots === 1 ? x : x + (i === 0 ? -width * 0.23 : width * 0.23);
    ctx.fillRect(px - potW / 2, top, potW, potH + 0.4);
    ctx.fillRect(px - potW * 0.62, top - 0.45, potW * 1.24, 0.7);
  }
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
  size: number,
  windowColor: string,
  trim: string,
): void {
  const w = Math.max(2.4, size);
  const h = w * 0.94;
  ctx.fillStyle = windowColor;
  ctx.fillRect(x - w / 2, y - h, w, h);
  fillTriangle(
    ctx,
    trim,
    { x: x - w * 0.72, y: y - h },
    { x, y: y - h - w * 0.66 },
    { x: x + w * 0.72, y: y - h },
  );
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
