import { drawIsoBlocks, drawIsoChrome } from './blocks.js';
import { drawIsoGround } from './ground.js';
import { drawIsoLabels } from './labels.js';
import { drawIsoOverlay } from './overlay.js';
import { drawIsoRoads } from './roads.js';
import type { IsoRenderState } from './state.js';

export {
  buildingAnchorScreen,
  geometryForModel,
  hitTestIso,
  hitTestIsoBuilding,
  levelsFor,
} from './geometry.js';
export { fitToBoundsIso, HZ, LEVEL_H } from './projection.js';
export { type LabelEngineState, createLabelEngineState } from './labels.js';
export type { IsoRenderState } from './state.js';

/**
 * One iso frame, back-to-front: ground (grass, paving, plazas, streets),
 * depth-ordered prisms with their podium buildings and yard decor, selection
 * chrome, selected/hover roads, the label engine, then the PR overlay
 * composited over everything — the same narrative order as the flat pipeline.
 */
export function renderIso(ctx: CanvasRenderingContext2D, s: IsoRenderState): void {
  ctx.save();
  drawIsoGround(ctx, s);
  drawIsoBlocks(ctx, s);
  drawIsoChrome(ctx, s);
  drawIsoRoads(ctx, s);
  drawIsoLabels(ctx, s);
  drawIsoOverlay(ctx, s);
  ctx.restore();
}
