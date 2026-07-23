import type { MapBuilding } from '@bendyline/gezel';
import { rectInView } from '../camera.js';
import {
  drawIssueMarker,
  issueMarkerStyle,
  issueMarkerZoomScale,
  representativeIssueBuilding,
} from '../issue-marker.js';
import type { RenderState } from './state.js';
import { screenRect } from './util.js';

/** Rooftop issue markers for the legacy flat renderer. */
export function drawIssueMarkers(ctx: CanvasRenderingContext2D, s: RenderState): void {
  if (s.tier === 'city' || s.ageLens) return;

  const byBlock = new Map<string, MapBuilding[]>();
  if (s.tier === 'street') {
    for (const building of s.model.buildings) {
      const list = byBlock.get(building.blockId);
      if (list) list.push(building);
      else byBlock.set(building.blockId, [building]);
    }
  }

  for (const block of s.model.blocks) {
    if (!rectInView(s.cam, block.rect, s.viewW, s.viewH)) continue;
    const style = issueMarkerStyle(block);
    if (!style) continue;

    const representative = representativeIssueBuilding(byBlock.get(block.id) ?? []);
    const r = screenRect(s.cam, representative?.rect ?? block.rect);
    drawIssueMarker(
      ctx,
      s.palette,
      style,
      r.x + r.w / 2,
      r.y,
      block.id,
      issueMarkerZoomScale(s.cam.scale),
      s.animationTime ?? 0,
    );
  }
}
