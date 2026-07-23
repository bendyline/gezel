import { roundRect } from '../draw/util.js';
import { buildingAnchorScreen, geomInView } from './geometry.js';
import { toIso } from './projection.js';
import { type IsoRenderState, sp } from './state.js';

/**
 * Screen-space label engine — the fix for the v2 map's overprinting. Gather
 * size-gated candidates, sort by priority, greedily accept non-colliding
 * plates. Hysteresis (last frame's accepted labels get a priority boost and a
 * shrunken collision box) keeps 1px pans from flickering labels; with no
 * persistent state (tests) the pass is a pure function of the frame.
 */

export interface LabelEngineState {
  accepted: Set<string>;
  measure: Map<string, number>;
}

export function createLabelEngineState(): LabelEngineState {
  return { accepted: new Set(), measure: new Map() };
}

interface Candidate {
  id: string;
  text: string;
  priority: number;
  /** Collision + plate rect (screen). */
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
  kind: 'district' | 'block' | 'landmark' | 'symbol';
  font: string;
  /** Rooftop point for a symbol tag's short leader line. */
  anchorX?: number;
  anchorY?: number;
}

const DISTRICT_FONT = '12px ui-sans-serif, system-ui, sans-serif';
const TOP_FONT = '13px ui-sans-serif, system-ui, sans-serif';
const BLOCK_FONT = '11px ui-sans-serif, system-ui, sans-serif';
const SYMBOL_FONT = '10px ui-sans-serif, system-ui, sans-serif';
const SYMBOL_TAG_H = 16;
const SYMBOL_TAG_MIN_SCALE = 2.35;
const SYMBOL_TAG_FULL_SCALE = 2.75;
const SYMBOL_TAG_MIN_FOOTPRINT_PX = 18;
const SYMBOL_TAG_MAX_CHARS = 28;

function measure(
  ctx: CanvasRenderingContext2D,
  state: LabelEngineState | undefined,
  font: string,
  text: string,
): number {
  const key = `${font}|${text}`;
  const cached = state?.measure.get(key);
  if (cached !== undefined) return cached;
  ctx.font = font;
  let w = 0;
  try {
    w = ctx.measureText(text).width;
  } catch {
    w = text.length * 6;
  }
  if (state) {
    if (state.measure.size > 8192) state.measure.clear();
    state.measure.set(key, w);
  }
  return w;
}

/** Alpha ramp: 0 below `from`, 1 above `to`. */
function ramp(scale: number, from: number, to: number): number {
  if (scale <= from) return 0;
  if (scale >= to) return 1;
  return (scale - from) / (to - from);
}

export function drawIsoLabels(ctx: CanvasRenderingContext2D, s: IsoRenderState): void {
  const { cam, model, palette } = s;
  const state = s.labels;
  const candidates: Candidate[] = [];

  // Districts: only display districts (collapsed chains label exactly once),
  // anchored at their reserved plate when present. Deeper districts fade out
  // as block labels fade in.
  for (const d of model.districts) {
    if (d.displayLabel === undefined) continue;
    const widthPx = (d.rect.w + d.rect.h) * cam.scale; // projected diamond width
    if (widthPx < 40) continue;
    const alpha =
      d.depth <= 1 ? 1 - 0.85 * ramp(cam.scale, 1.6, 2.6) : 1 - 0.85 * ramp(cam.scale, 2.0, 3.2);
    if (alpha <= 0.05) continue;
    const font = d.depth <= 1 ? TOP_FONT : DISTRICT_FONT;
    const textW = measure(ctx, state, font, d.displayLabel);
    const anchor = d.labelPlate
      ? { x: d.labelPlate.x, y: d.labelPlate.y }
      : { x: d.rect.x, y: d.rect.y };
    const pt = sp(cam, toIso(anchor.x, anchor.y).u, toIso(anchor.x, anchor.y).v);
    candidates.push({
      id: `d:${d.id}`,
      text: d.displayLabel,
      priority: 3 + d.depth,
      x: pt.x,
      y: pt.y - 8,
      w: textW + 12,
      h: 17,
      alpha,
      kind: 'district',
      font,
    });
  }

  for (const idx of s.geom.order) {
    const g = s.geom.geoms[idx]!;
    const b = g.block;
    if (b.state === 'tombstoned') continue;
    if (!geomInView(cam, g, s.viewW, s.viewH)) continue;
    const isSelected = b.id === s.selectedId;
    const isHovered = b.id === s.hoverId;
    const isLandmark = b.landmark === true;
    if (!isSelected && !isHovered && !isLandmark) {
      if (s.tier !== 'street') continue;
      if (b.rect.w * cam.scale * 2 < 44) continue;
      const alpha = 0.9 * ramp(cam.scale, 1.2, 1.6);
      if (alpha <= 0.05) continue;
      const textW = measure(ctx, state, BLOCK_FONT, b.label);
      const front = sp(
        cam,
        toIso(b.rect.x + b.rect.w, b.rect.y + b.rect.h).u,
        toIso(b.rect.x + b.rect.w, b.rect.y + b.rect.h).v,
      );
      candidates.push({
        id: `b:${b.id}`,
        text: b.label,
        priority: 10,
        x: front.x - textW / 2,
        y: front.y + 2,
        w: textW,
        h: 12,
        alpha,
        kind: 'block',
        font: BLOCK_FONT,
      });
      continue;
    }
    const font = BLOCK_FONT;
    const textW = measure(ctx, state, font, b.label);
    const c = toIso(b.rect.x + b.rect.w / 2, b.rect.y + b.rect.h / 2);
    const pt = sp(cam, c.u, c.v);
    candidates.push({
      id: `b:${b.id}`,
      text: b.label,
      priority: isSelected ? 0 : isHovered ? 1 : 2,
      x: pt.x - textW / 2,
      y: pt.y - g.hIso * cam.scale - 18,
      w: textW,
      h: 13,
      alpha: 1,
      kind: 'landmark',
      font,
    });
  }

  // Close-detail stage: name the miniature symbol buildings once they are
  // physically large enough to carry a tag. Functions and methods win
  // collisions, followed by type-like symbols, then everything else. This
  // keeps a dense file readable while zooming reveals progressively more.
  const symbolAlpha = s.ageLens ? 0 : ramp(cam.scale, SYMBOL_TAG_MIN_SCALE, SYMBOL_TAG_FULL_SCALE);
  if (symbolAlpha > 0.05) {
    const visibleBlockIds = new Set(
      model.blocks
        .filter((b) => b.state === 'live' && !b.phantom && b.buildingCount > 0)
        .map((b) => b.id),
    );
    for (const building of model.buildings) {
      if (!visibleBlockIds.has(building.blockId)) continue;
      const footprintPx = (building.rect.w + building.rect.h) * cam.scale;
      if (footprintPx < SYMBOL_TAG_MIN_FOOTPRINT_PX) continue;

      const anchor = buildingAnchorScreen(cam, building);
      if (anchor.x < -80 || anchor.x > s.viewW + 80 || anchor.y < -40 || anchor.y > s.viewH + 40) {
        continue;
      }
      const text = compactSymbolLabel(building.label);
      const textW = measure(ctx, state, SYMBOL_FONT, text);
      const w = Math.min(180, Math.max(20, textW + 10));
      const x = Math.max(2, Math.min(s.viewW - w - 2, anchor.x - w / 2));
      candidates.push({
        id: `s:${building.id}`,
        text,
        priority: symbolPriority(building.kind, building.lines),
        x,
        y: anchor.y - SYMBOL_TAG_H - 5,
        w,
        h: SYMBOL_TAG_H,
        alpha: symbolAlpha,
        kind: 'symbol',
        font: SYMBOL_FONT,
        anchorX: anchor.x,
        anchorY: anchor.y,
      });
    }
  }

  // Deterministic order: priority (hysteresis boost), then id.
  const boost = (c: Candidate): number =>
    state?.accepted.has(c.id) ? c.priority - 0.5 : c.priority;
  candidates.sort((a, b) => boost(a) - boost(b) || (a.id < b.id ? -1 : 1));

  const placed: Candidate[] = [];
  const nextAccepted = new Set<string>();
  for (const c of candidates) {
    // Shrink the collision box of labels shown last frame, so a 1px pan
    // never toggles them.
    const pad = state?.accepted.has(c.id) ? 2 : 0;
    let collides = false;
    for (const other of placed) {
      if (
        c.x + pad < other.x + other.w &&
        c.x + c.w - pad > other.x &&
        c.y + pad < other.y + other.h &&
        c.y + c.h - pad > other.y
      ) {
        collides = true;
        break;
      }
    }
    if (collides) continue;
    placed.push(c);
    nextAccepted.add(c.id);
  }
  if (state) {
    state.accepted = nextAccepted;
  }

  ctx.textBaseline = 'top';
  for (const c of placed) {
    ctx.globalAlpha = c.alpha;
    ctx.font = c.font;
    if (c.kind === 'district') {
      ctx.fillStyle = palette.labelPlate;
      roundRect(ctx, c.x, c.y, c.w, c.h, 3);
      ctx.fill();
      ctx.strokeStyle = palette.labelPlateStroke;
      ctx.lineWidth = 1;
      roundRect(ctx, c.x, c.y, c.w, c.h, 3);
      ctx.stroke();
      ctx.fillStyle = palette.districtLabel;
      ctx.fillText(c.text, c.x + 6, c.y + 3, c.w - 12);
    } else if (c.kind === 'symbol') {
      // A short leader keeps the tag attached to its rooftop while the small,
      // mostly-square plate remains legible over detailed buildings.
      ctx.strokeStyle = palette.labelPlateStroke;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(Math.max(c.x + 4, Math.min(c.x + c.w - 4, c.anchorX ?? c.x + c.w / 2)), c.y + c.h);
      ctx.lineTo(c.anchorX ?? c.x + c.w / 2, c.anchorY ?? c.y + c.h + 5);
      ctx.stroke();
      ctx.fillStyle = palette.labelPlate;
      roundRect(ctx, c.x, c.y, c.w, c.h, 3);
      ctx.fill();
      ctx.strokeStyle = palette.labelPlateStroke;
      roundRect(ctx, c.x, c.y, c.w, c.h, 3);
      ctx.stroke();
      ctx.fillStyle = palette.label;
      ctx.fillText(c.text, c.x + 5, c.y + 2, c.w - 10);
    } else if (c.kind === 'landmark') {
      // Halo text above the prism with a pointer tick.
      ctx.strokeStyle = palette.ground;
      ctx.lineWidth = 3;
      ctx.strokeText(c.text, c.x, c.y, c.w + 4);
      ctx.fillStyle = palette.label;
      ctx.fillText(c.text, c.x, c.y, c.w + 4);
      ctx.strokeStyle = palette.districtLabel;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(c.x + c.w / 2, c.y + c.h + 1);
      ctx.lineTo(c.x + c.w / 2, c.y + c.h + 5);
      ctx.stroke();
    } else {
      ctx.strokeStyle = palette.ground;
      ctx.lineWidth = 3;
      ctx.strokeText(c.text, c.x, c.y, c.w + 4);
      ctx.fillStyle = palette.label;
      ctx.fillText(c.text, c.x, c.y, c.w + 4);
    }
  }
  ctx.globalAlpha = 1;
}

function compactSymbolLabel(label: string): string {
  if (label.length <= SYMBOL_TAG_MAX_CHARS) return label;
  return `${label.slice(0, SYMBOL_TAG_MAX_CHARS - 1)}…`;
}

function symbolPriority(kind: string, lines: number | undefined): number {
  const normalized = kind.toLowerCase();
  const kindRank = /function|method|constructor|procedure/.test(normalized)
    ? 0
    : /class|interface|struct|enum|trait|type/.test(normalized)
      ? 1
      : 2;
  const sizeBoost = Math.min(0.2, Math.max(0, lines ?? 0) / 2000);
  return 20 + kindRank - sizeBoost;
}
