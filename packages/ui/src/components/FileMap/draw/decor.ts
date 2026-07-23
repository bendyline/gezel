import { rectInView, worldToScreenX, worldToScreenY } from '../camera.js';
import { decorForModel } from '../decor.js';
import type { SpriteAtlas } from '../sprites.js';
import type { RenderState } from './state.js';

/** Per-frame blit budget — decor is garnish, never the frame's main cost. */
const MAX_BLITS = 3000;
/** Above this many blocks, decor only renders at street zoom. */
const DENSE_CITY_BLOCKS = 6000;
/** At district zoom, decorate only blocks at least this wide on screen. */
const MIN_BLOCK_PX_DISTRICT = 14;

/**
 * Blit the yard decorations (trees, shrubs, weeds, rubble patches). Skipped
 * entirely at city zoom, without an atlas (jsdom), or under the age lens —
 * the lens tells one story and decor would muddy it.
 */
export function drawDecor(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  atlas: SpriteAtlas | null | undefined,
): void {
  if (!atlas || s.tier === 'city' || s.ageLens) return;
  if (s.tier === 'district' && s.model.blocks.length > DENSE_CITY_BLOCKS) return;
  const decor = decorForModel(s.model);
  if (decor.size === 0) return;

  let budget = MAX_BLITS;
  for (const b of s.model.blocks) {
    const list = decor.get(b.id);
    if (!list || list.length === 0) continue;
    const box = b.lot ?? b.rect;
    if (!rectInView(s.cam, box, s.viewW, s.viewH)) continue;
    if (s.tier === 'district' && box.w * s.cam.scale <= MIN_BLOCK_PX_DISTRICT) continue;
    for (const d of list) {
      const size = d.size * s.cam.scale;
      if (size < 2.5) continue;
      if (budget-- <= 0) return;
      const sx = atlas.index[d.sprite] * atlas.cell;
      ctx.drawImage(
        atlas.canvas,
        sx,
        0,
        atlas.cell,
        atlas.cell,
        worldToScreenX(s.cam, d.x) - size / 2,
        worldToScreenY(s.cam, d.y) - size / 2,
        size,
        size,
      );
    }
  }
}
