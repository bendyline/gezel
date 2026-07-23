import type { Camera } from '../camera.js';
import type { RenderState } from '../draw/state.js';
import type { GeometryCache } from './geometry.js';
import type { LabelEngineState } from './labels.js';

/** Iso frame state: the flat RenderState plus the per-model geometry cache
 *  and the (optional, persistent) label-engine state. */
export interface IsoRenderState extends RenderState {
  geom: GeometryCache;
  labels?: LabelEngineState;
}

export interface ScreenPt {
  x: number;
  y: number;
}

/** Iso-plane point → screen (the unchanged camera, over (u, v)). */
export function sp(cam: Camera, u: number, v: number): ScreenPt {
  return { x: (u - cam.offsetX) * cam.scale, y: (v - cam.offsetY) * cam.scale };
}
