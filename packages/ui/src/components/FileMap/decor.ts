import type { FileMapResponse, MapBlock } from '@bendyline/gezel';
import { hash32, seeded } from './seed.js';
import type { SpriteKey } from './sprites.js';

/**
 * Yard decoration — the "healthy files have trees" layer. Pure derivation
 * from a block's health verdict: positions land in the yard bands between the
 * lot edge and the building footprint, seeded by the block id so the same
 * file always keeps the same garden. Rendering (sprite blits) lives in
 * draw/decor.ts; this module owns only the *what and where*.
 */

export interface DecorInstance {
  sprite: SpriteKey;
  /** World-space center. */
  x: number;
  y: number;
  /** World-space size (square). */
  size: number;
}

const TREES: SpriteKey[] = ['tree1', 'tree2', 'tree3'];

export function deriveBlockDecor(b: MapBlock): DecorInstance[] {
  const lot = b.lot;
  if (!lot || b.phantom || b.state === 'tombstoned') return [];
  const vibe = b.health?.vibe ?? 'plain';
  if (vibe === 'plain') return [];

  const rng = seeded(hash32(b.id));
  const foot = b.rect;
  const out: DecorInstance[] = [];

  // A point in one of the four yard bands (between lot edge and footprint),
  // biased toward the bottom band — the front setback is the widest yard.
  const yardPoint = (): { x: number; y: number } => {
    const pick = rng();
    const alongX = lot.x + 1 + rng() * Math.max(0.5, lot.w - 2);
    const alongY = lot.y + 1 + rng() * Math.max(0.5, lot.h - 2);
    if (pick < 0.45) return { x: alongX, y: (foot.y + foot.h + lot.y + lot.h) / 2 };
    if (pick < 0.6) return { x: alongX, y: (lot.y + foot.y) / 2 };
    if (pick < 0.8) return { x: (lot.x + foot.x) / 2, y: alongY };
    return { x: (foot.x + foot.w + lot.x + lot.w) / 2, y: alongY };
  };

  const add = (sprite: SpriteKey, sizeLo: number, sizeHi: number): void => {
    const { x, y } = yardPoint();
    out.push({ sprite, x, y, size: sizeLo + rng() * (sizeHi - sizeLo) });
  };
  const addTree = (): void => add(TREES[Math.floor(rng() * TREES.length)]!, 2.2, 3.4);

  switch (vibe) {
    case 'lush': {
      const trees = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < trees; i++) addTree();
      const shrubs = 1 + (rng() < 0.5 ? 1 : 0);
      for (let i = 0; i < shrubs; i++) add('shrub', 1.5, 2.2);
      break;
    }
    case 'tidy': {
      const trees = 1 + (rng() < 0.5 ? 1 : 0);
      for (let i = 0; i < trees; i++) addTree();
      break;
    }
    case 'scruffy': {
      add('dryPatch', 2.5, 4);
      const weeds = 1 + (rng() < 0.5 ? 1 : 0);
      for (let i = 0; i < weeds; i++) add('weed', 1.6, 2.4);
      break;
    }
    case 'blighted': {
      add('dryPatch', 2.5, 4);
      add('deadTree', 2.6, 3.6);
      const weeds = 1 + (rng() < 0.5 ? 1 : 0);
      for (let i = 0; i < weeds; i++) add('weed', 1.6, 2.4);
      break;
    }
  }
  return out;
}

const modelDecor = new WeakMap<FileMapResponse, Map<string, DecorInstance[]>>();

/** Per-model memo: decor is derived once per payload, not per frame. */
export function decorForModel(model: FileMapResponse): Map<string, DecorInstance[]> {
  const hit = modelDecor.get(model);
  if (hit) return hit;
  const map = new Map<string, DecorInstance[]>();
  for (const b of model.blocks) {
    const list = deriveBlockDecor(b);
    if (list.length) map.set(b.id, list);
  }
  modelDecor.set(model, map);
  return map;
}
