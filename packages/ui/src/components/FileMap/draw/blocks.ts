import type { MapBlock } from '@bendyline/gezel';
import { rectInView } from '../camera.js';
import { ageBucket, roofColors } from '../palette.js';
import { hash32, seeded } from '../seed.js';
import type { RenderState } from './state.js';
import { type ScreenRect, crosshatchPattern, roundRect, screenRect } from './util.js';

// Fixed screen-space shadow offset — a soft ambient drop, not a scaled sun.
const SHADOW_OX = 1.5;
const SHADOW_OY = 2.5;
/** Below this screen width a block renders flat — 3D at that size is mud. */
const MIN_3D_PX = 6;
/** LoC above which a block-as-building reads as an industrial complex. */
const INDUSTRIAL_LOC = 1000;

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
  return s.tier === 'street' && b.buildingCount > 0;
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

/** Zone/vibe ground treatment on the lot: civic plaza, blighted earth. */
function drawLotGround(ctx: CanvasRenderingContext2D, s: RenderState, v: VisibleBlock): void {
  const { b } = v;
  const p = s.palette;
  if (b.state !== 'live' || b.phantom || !b.lot || !b.health) return;
  const lr = screenRect(s.cam, b.lot);
  if (lr.w < 10) return;
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

  if (!s.ageLens) drawZoneRoof(ctx, s, v, r.h - wallH, colors);
}

/**
 * Zone → building type, told through the roof: houses get gables, shops get
 * awnings, civic hubs a dome, big files sawtooth industry. Falls back to the
 * weight-based industrial look when no health payload rides on the block.
 */
function drawZoneRoof(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  v: VisibleBlock,
  roofH: number,
  colors: { roof: string; facade: string; edge: string },
): void {
  const { b, r } = v;
  const zone = b.health?.zone;
  if ((zone === 'industrial' || (!b.health && b.weight > INDUSTRIAL_LOC)) && roofH >= 12) {
    drawIndustrialRoof(ctx, s, v, roofH, colors.facade, colors.edge);
    return;
  }
  if (r.w < 14 || roofH < 10) return;
  if (zone === 'residential') {
    // gabled two-tone roof: lit and shaded halves split by a ridge line
    const horizontal = r.w >= roofH;
    ctx.globalAlpha = 0.22;
    if (horizontal) {
      ctx.fillStyle = colors.edge;
      ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, roofH / 2 - 1);
      ctx.fillStyle = colors.facade;
      ctx.fillRect(r.x + 1, r.y + roofH / 2, r.w - 2, roofH / 2 - 1);
    } else {
      ctx.fillStyle = colors.edge;
      ctx.fillRect(r.x + 1, r.y + 1, r.w / 2 - 1, roofH - 2);
      ctx.fillStyle = colors.facade;
      ctx.fillRect(r.x + r.w / 2, r.y + 1, r.w / 2 - 1, roofH - 2);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.edge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(r.x + 1, r.y + roofH / 2);
      ctx.lineTo(r.x + r.w - 1, r.y + roofH / 2);
    } else {
      ctx.moveTo(r.x + r.w / 2, r.y + 1);
      ctx.lineTo(r.x + r.w / 2, r.y + roofH - 1);
    }
    ctx.stroke();
  } else if (zone === 'commercial') {
    // flat roof with a parapet edge and an awning strip facing the lane
    ctx.strokeStyle = colors.facade;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 1.5, r.y + 1.5, r.w - 3, roofH - 3);
    ctx.globalAlpha = 1;
    const awnH = Math.min(3, roofH * 0.18);
    ctx.fillStyle = colors.edge;
    ctx.fillRect(r.x + 1, r.y + roofH - awnH, r.w - 2, awnH);
  } else if (zone === 'civic') {
    const cr = Math.min(r.w, roofH) * 0.18;
    ctx.fillStyle = s.palette.domeAccent;
    ctx.beginPath();
    ctx.arc(r.x + r.w / 2, r.y + roofH / 2, cr, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.facade;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(r.x + r.w / 2, r.y + roofH / 2, cr, 0, Math.PI * 2);
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
