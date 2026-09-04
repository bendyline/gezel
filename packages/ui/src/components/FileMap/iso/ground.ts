import type { MapPlaza } from '@bendyline/gezel';
import { hash32, seeded } from '../seed.js';
import { districtBands } from '../urbanity.js';
import { pathGroundRect } from './prism.js';
import { groundRectInView, toIso } from './projection.js';
import { type IsoRenderState, type ScreenPt, sp } from './state.js';
import { drawIsoStreets } from './streets.js';

/**
 * The iso ground plane: grass, district ground by register (meadow in the
 * village band, paving in town, harder grey in the core), plazas and greens
 * with their fountains and trees, then the street network — see
 * `streets.ts` for the road grades. Sharp corners throughout — rounded rects
 * become elliptical arcs in iso, and sharp is the SimCity idiom.
 */

/** Below this projected plaza width a fountain is a blob. */
const MIN_FOUNTAIN_PX = 14;
const MAX_GREEN_TREES = 6;

export function drawIsoGround(ctx: CanvasRenderingContext2D, s: IsoRenderState): void {
  const { cam, model, palette, viewW, viewH } = s;

  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, 0, viewW, viewH);

  const parentIds = new Set<string>();
  for (const d of model.districts) if (d.parentId) parentIds.add(d.parentId);
  const bands = s.tier === 'city' ? null : districtBands(model);

  // District ground: leaf districts filled, ancestors as faint outlines.
  for (const d of model.districts) {
    if (!groundRectInView(cam, d.rect, viewW, viewH)) continue;
    if (parentIds.has(d.id)) {
      ctx.strokeStyle = palette.districtStroke;
      ctx.lineWidth = Math.max(0.5, Math.min(2, 3 - d.depth * 0.4));
      pathGroundRect(ctx, cam, d.rect);
      ctx.stroke();
      continue;
    }
    const band = bands?.get(d.id);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle =
      band === 'village'
        ? palette.districtFillVillage
        : band === 'city'
          ? palette.districtFillCity
          : palette.districtFill;
    pathGroundRect(ctx, cam, d.rect);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (s.tier !== 'city') {
      ctx.strokeStyle = palette.curb;
      ctx.lineWidth = 1;
      pathGroundRect(ctx, cam, d.rect);
      ctx.stroke();
    }
  }

  // Plazas and greens sit on the paving, under the streets' crossings.
  for (const pz of model.plazas ?? []) {
    if (!groundRectInView(cam, pz.rect, viewW, viewH)) continue;
    if (pz.kind === 'plaza') {
      ctx.fillStyle = palette.sidewalk;
      pathGroundRect(ctx, cam, pz.rect);
      ctx.fill();
      if (s.tier === 'street' && !s.ageLens) {
        ctx.strokeStyle = palette.domeAccent;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        pathGroundRect(ctx, cam, pz.rect);
        ctx.stroke();
        ctx.globalAlpha = 1;
        drawFountain(ctx, s, pz);
      }
    } else {
      ctx.fillStyle = palette.dark ? 'hsl(130 12% 15%)' : 'hsl(90 26% 80%)';
      pathGroundRect(ctx, cam, pz.rect);
      ctx.fill();
      if (s.tier === 'street' && !s.ageLens) drawGreenTrees(ctx, s, pz);
    }
  }

  drawIsoStreets(ctx, s);
}

/**
 * A fountain at the centre of a landmark's square: an iso basin (a world
 * circle projects to a 2:1 ellipse), the water, and a jet. The one civic
 * ornament every 1900s town square had.
 */
function drawFountain(ctx: CanvasRenderingContext2D, s: IsoRenderState, pz: MapPlaza): void {
  const { cam } = s;
  const r = Math.min(pz.rect.w, pz.rect.h) * 0.22;
  const rx = r * Math.SQRT2 * cam.scale;
  if (rx < MIN_FOUNTAIN_PX / 2) return;
  const c = toIso(pz.rect.x + pz.rect.w / 2, pz.rect.y + pz.rect.h / 2);
  drawFountainAt(ctx, s, sp(cam, c.u, c.v), rx);
}

/** The fountain itself, at a screen point with a semi-major axis of `rx` px.
 *  Shared with the park painter. */
export function drawFountainAt(
  ctx: CanvasRenderingContext2D,
  s: IsoRenderState,
  pt: ScreenPt,
  rx: number,
): void {
  const { cam, palette } = s;
  const ry = rx / 2;
  const rim = Math.max(1, 0.28 * cam.scale);

  ctx.fillStyle = palette.street.basin;
  ctx.beginPath();
  ctx.ellipse(pt.x, pt.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = palette.street.water;
  ctx.beginPath();
  ctx.ellipse(pt.x, pt.y, rx - rim, ry - rim / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  // The jet: a short column with a bright cap, and a ripple ring below it.
  ctx.strokeStyle = palette.street.water;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = Math.max(0.6, 0.2 * cam.scale);
  ctx.beginPath();
  ctx.ellipse(pt.x, pt.y, rx * 0.45, ry * 0.45, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  const jet = Math.max(2, 1.1 * cam.scale);
  ctx.strokeStyle = palette.sidewalk;
  ctx.lineWidth = Math.max(0.8, 0.3 * cam.scale);
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y);
  ctx.lineTo(pt.x, pt.y - jet);
  ctx.stroke();
  ctx.fillStyle = palette.sidewalk;
  ctx.beginPath();
  ctx.arc(pt.x, pt.y - jet, Math.max(0.8, 0.28 * cam.scale), 0, Math.PI * 2);
  ctx.fill();
}

/** A green is a small park: a few trees, seeded by the green's id. */
function drawGreenTrees(ctx: CanvasRenderingContext2D, s: IsoRenderState, pz: MapPlaza): void {
  const atlas = s.atlas;
  if (!atlas) return;
  const { cam } = s;
  const area = pz.rect.w * pz.rect.h;
  const count = Math.max(1, Math.min(MAX_GREEN_TREES, Math.floor(area / 500)));
  const rng = seeded(hash32(`green:${pz.id}`));
  for (let i = 0; i < count; i++) {
    const x = pz.rect.x + 2 + rng() * Math.max(0.5, pz.rect.w - 4);
    const y = pz.rect.y + 2 + rng() * Math.max(0.5, pz.rect.h - 4);
    const size = (2 + rng() * 1.2) * cam.scale * 2;
    const sprite = rng() < 0.7 ? 'tree1' : 'tree3';
    const iso = toIso(x, y);
    const pt = sp(cam, iso.u, iso.v);
    const src = atlas.index[sprite] * atlas.cell;
    ctx.drawImage(
      atlas.canvas,
      src,
      0,
      atlas.cell,
      atlas.cell,
      pt.x - size / 2,
      pt.y - size,
      size,
      size,
    );
  }
}
