import { drawBlockChrome, drawBlocks } from './blocks.js';
import { drawBuildings } from './buildings.js';
import { drawDecor } from './decor.js';
import { drawGround } from './ground.js';
import { drawIssueMarkers } from './issues.js';
import { drawLabels } from './labels.js';
import { drawOverlay } from './overlay.js';
import { drawRoads } from './roads.js';
import type { RenderState } from './state.js';

export type { RenderState } from './state.js';

/**
 * One frame of the city, painted back-to-front: ground, streets and paved
 * districts, import ribbons under the buildings, blocks (shadow → facade →
 * roof), symbol buildings, yard decor (canopies may overlap roof edges), issue
 * markers, selection chrome with its roads re-lit on top, labels, then the PR
 * overlay composited over everything.
 */
export function render(ctx: CanvasRenderingContext2D, s: RenderState): void {
  ctx.save();
  drawGround(ctx, s);
  drawRoads(ctx, s, 'under');
  drawBlocks(ctx, s);
  drawBuildings(ctx, s);
  drawDecor(ctx, s, s.atlas);
  drawIssueMarkers(ctx, s);
  drawBlockChrome(ctx, s);
  drawRoads(ctx, s, 'selected');
  drawLabels(ctx, s);
  drawOverlay(ctx, s);
  ctx.restore();
}
