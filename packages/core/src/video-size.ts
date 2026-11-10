/**
 * The width, height and frame count a video request renders at. The video
 * sibling of `resolveImageSize`: a requested shape, or the shape of the
 * picture being animated, keeps the model's trained area; every side lands
 * on the architecture's token grid and every frame count on its VAE's frame
 * grid (`video-geometry.ts`), inside the catalog's ranges.
 *
 * Pure and browser-safe.
 */
import { aspectRatioValue } from './image-size.js';
import type { ImageAspectRatio } from './schemas/image.js';
import {
  type VideoArchitectureGeometry,
  snapVideoFrames,
  videoFrameStep,
  videoSizeMultiple,
} from './video-geometry.js';

export interface VideoSizeModel {
  defaultWidth?: number | undefined;
  defaultHeight?: number | undefined;
  widthRange?: { min: number; max: number } | undefined;
  heightRange?: { min: number; max: number } | undefined;
}

export interface VideoSizeRequest {
  width?: number | undefined;
  height?: number | undefined;
  aspectRatio?: ImageAspectRatio | undefined;
  /** The picture being animated; its shape sets the clip's when none was asked for. */
  sourceSize?: { width: number; height: number } | undefined;
}

const FALLBACK_SIZE = { width: 832, height: 480 };

function inRange(px: number, multiple: number, range?: { min: number; max: number }): number {
  const snapped = Math.max(multiple, Math.round(px / multiple) * multiple);
  if (!range) return snapped;
  const lo = Math.ceil(range.min / multiple) * multiple;
  const hi = Math.max(lo, Math.floor(range.max / multiple) * multiple);
  return Math.min(hi, Math.max(lo, snapped));
}

export function resolveVideoSize(
  request: VideoSizeRequest,
  model: VideoSizeModel,
  geo: VideoArchitectureGeometry,
): { width: number; height: number } {
  const multiple = videoSizeMultiple(geo);
  const defaultWidth = model.defaultWidth ?? FALLBACK_SIZE.width;
  const defaultHeight = model.defaultHeight ?? FALLBACK_SIZE.height;
  let width: number;
  let height: number;
  if (request.width !== undefined && request.height !== undefined) {
    width = request.width;
    height = request.height;
  } else {
    const source = request.sourceSize;
    const ratio = request.aspectRatio
      ? aspectRatioValue(request.aspectRatio)
      : source && source.width > 0 && source.height > 0
        ? source.width / source.height
        : undefined;
    if (ratio === undefined) {
      width = request.width ?? defaultWidth;
      height = request.height ?? defaultHeight;
    } else {
      const area = defaultWidth * defaultHeight;
      width = request.width ?? Math.sqrt(area * ratio);
      height = request.height ?? Math.sqrt(area / ratio);
      if (request.width !== undefined) height = request.width / ratio;
      if (request.height !== undefined) width = request.height * ratio;
    }
  }
  // Shrink both sides together so a too-wide shape stays the same shape.
  const shrink = Math.min(
    1,
    model.widthRange ? model.widthRange.max / width : 1,
    model.heightRange ? model.heightRange.max / height : 1,
  );
  return {
    width: inRange(width * shrink, multiple, model.widthRange),
    height: inRange(height * shrink, multiple, model.heightRange),
  };
}

export interface VideoFramesModel {
  defaultNumFrames?: number | undefined;
  numFramesRange?: { min: number; max: number } | undefined;
  maxDurationSeconds?: number | undefined;
}

/**
 * The frame count a request renders: the one asked for, else the model's
 * default, capped at the model's longest clip, inside its range, and on the
 * VAE's frame grid (rounded down, as the engines round it).
 */
export function resolveVideoFrames(
  numFrames: number | undefined,
  model: VideoFramesModel,
  fps: number,
  geo: VideoArchitectureGeometry,
): number {
  let frames = numFrames ?? model.defaultNumFrames ?? 81;
  if (model.maxDurationSeconds !== undefined && fps > 0) {
    frames = Math.min(frames, Math.floor(model.maxDurationSeconds * fps) + 1);
  }
  const range = model.numFramesRange;
  if (range) frames = Math.min(range.max, Math.max(range.min, frames));
  let snapped = snapVideoFrames(geo, frames);
  if (range && snapped < range.min) snapped += videoFrameStep(geo);
  return snapped;
}
