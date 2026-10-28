/**
 * The pixel size an image request renders at.
 *
 * People and models think in shapes ("9:16", "a quick draft"), and engines
 * take pixels. Every caller resolves one through here: the generate route
 * before a local engine renders, the direct image gezel's settings strip for
 * its readout, and memory pricing for the size a model renders when nothing
 * is asked. A local model renders best at the area it was trained at, so a
 * shape keeps that area and a quality tier scales it (image bench,
 * 2026-10-19: SDXL Base garbles and SDXL Lightning tiles below it).
 *
 * Pure and browser-safe.
 */
import type { ImageAspectRatio, ImageQuality } from './schemas/image.js';

/**
 * Models trained at about a megapixel. SD 1.5, SD-Turbo and SDXL-Turbo were
 * trained at 512px and render best there; an unknown model gets 512 too.
 */
const MODEL_1024PX_DEFAULT = new Set<string>([
  'animagine-xl-4',
  'flux-2-klein-4b-q4',
  'krea-2-turbo-q4',
  'krea-2-turbo-q6',
  'krea-2-turbo-q8',
  'sdxl-base-1.0',
  'sdxl-lightning-4step',
  'ming-image-0.1-design-bf16',
  'moss-image-sft-q4',
  'iris-3b-f32',
  'qwen-image-edit-2511-q4',
]);

/** The square side, in pixels, a local model renders at when nothing is asked. */
export function imageModelDefaultSide(modelId: string | undefined): number {
  return modelId && MODEL_1024PX_DEFAULT.has(modelId) ? 1024 : 512;
}

/** Area multiplier per quality tier, against the model's trained area. */
export const IMAGE_QUALITY_AREA: Readonly<Record<ImageQuality, number>> = {
  draft: 0.25,
  standard: 1,
  high: 2.25,
};

/** Width over height. */
export function aspectRatioValue(ratio: ImageAspectRatio): number {
  const [w, h] = ratio.split(':').map(Number) as [number, number];
  return w / h;
}

const ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  '1:1',
  '4:5',
  '5:4',
  '3:4',
  '4:3',
  '2:3',
  '3:2',
  '9:16',
  '16:9',
  '21:9',
];

/** The named ratio closest to a pixel size, compared in log space. */
export function nearestAspectRatio(width: number, height: number): ImageAspectRatio {
  const target = Math.log(width / height);
  let best: ImageAspectRatio = '1:1';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of ASPECT_RATIOS) {
    const distance = Math.abs(Math.log(aspectRatioValue(ratio)) - target);
    if (distance < bestDistance) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
}

export interface ImageSizeRange {
  widthRange?: { min: number; max: number } | undefined;
  heightRange?: { min: number; max: number } | undefined;
}

/**
 * Every size this module produces lands on 64. Flux, Krea and MOSS take
 * multiples of 16, but the SD and SDXL UNets take 64: sd-server rounded an
 * SDXL-Turbo 512x944 up to 512x960 (image bench, 2026-10-19).
 */
const FIT_MULTIPLE = 64;
const SHAPE_MULTIPLE = 64;

/**
 * Bring a requested size inside the model's declared range, keeping its
 * aspect ratio where both sides can fit, on multiples of 64. A size already
 * inside the range is returned unchanged, so
 * only requests the model does not support are touched: Ming's minimum is
 * 1024, and the agent tool's 768 cap once handed it 768x768.
 */
export function fitImageSizeToRange(
  size: { width?: number | undefined; height?: number | undefined },
  range: ImageSizeRange,
): { width?: number; height?: number } {
  const { width, height } = size;
  const wr = range.widthRange;
  const hr = range.heightRange;
  const inside = (v: number | undefined, r: typeof wr) =>
    v === undefined || !r || (v >= r.min && v <= r.max);
  if (inside(width, wr) && inside(height, hr)) {
    return { ...(width ? { width } : {}), ...(height ? { height } : {}) };
  }
  const clamp = (v: number, r: typeof wr) => {
    const q = Math.max(FIT_MULTIPLE, Math.round(v / FIT_MULTIPLE) * FIT_MULTIPLE);
    return r ? Math.min(r.max, Math.max(r.min, q)) : q;
  };
  if (width === undefined || height === undefined) {
    return {
      ...(width !== undefined ? { width: clamp(width, wr) } : {}),
      ...(height !== undefined ? { height: clamp(height, hr) } : {}),
    };
  }
  let scale = 1;
  if (wr && width < wr.min) scale = Math.max(scale, wr.min / width);
  if (hr && height < hr.min) scale = Math.max(scale, hr.min / height);
  if (wr && width * scale > wr.max) scale = Math.min(scale, wr.max / width);
  if (hr && height * scale > hr.max) scale = Math.min(scale, hr.max / height);
  return { width: clamp(width * scale, wr), height: clamp(height * scale, hr) };
}

const toMultiple = (v: number, multiple = SHAPE_MULTIPLE) =>
  Math.max(multiple, Math.round(v / multiple) * multiple);

/**
 * An agent's explicit pixels are held to about a megapixel, the size most
 * current models were trained at, before the model's range applies, so SD 1.5
 * still lands at 768 and Ming at no less than 1024. A cap below the training
 * size degrades the image rather than speeding it up: SDXL-class models garble
 * composition at 512. Local engines only; a cloud provider takes the size as
 * asked.
 */
const AGENT_IMAGE_MAX_SIDE_PX = 1024;

export function capAgentImageSize<
  T extends { width?: number | undefined; height?: number | undefined },
>(request: T): { request: T; note?: string } {
  const { width, height } = request;
  const capped = (v: number) => Math.min(AGENT_IMAGE_MAX_SIDE_PX, toMultiple(v, FIT_MULTIPLE));
  let note: string | undefined;
  const next = { ...request };
  if (width !== undefined && height !== undefined) {
    const maxSide = Math.max(width, height);
    if (maxSide > AGENT_IMAGE_MAX_SIDE_PX) {
      const scale = AGENT_IMAGE_MAX_SIDE_PX / maxSide;
      next.width = capped(width * scale);
      next.height = capped(height * scale);
      note = `Size ${width}x${height} held to ${next.width}x${next.height} for a local engine.`;
    }
  } else if (width !== undefined && width > AGENT_IMAGE_MAX_SIDE_PX) {
    next.width = AGENT_IMAGE_MAX_SIDE_PX;
    note = `Width ${width} held to ${AGENT_IMAGE_MAX_SIDE_PX} for a local engine.`;
  } else if (height !== undefined && height > AGENT_IMAGE_MAX_SIDE_PX) {
    next.height = AGENT_IMAGE_MAX_SIDE_PX;
    note = `Height ${height} held to ${AGENT_IMAGE_MAX_SIDE_PX} for a local engine.`;
  }
  return { request: next, ...(note ? { note } : {}) };
}

export interface ImageSizeRequest {
  width?: number | undefined;
  height?: number | undefined;
  aspectRatio?: ImageAspectRatio | undefined;
  quality?: ImageQuality | undefined;
  /** The picture an edit changes. Its shape is the edit's when none is asked. */
  sourceSize?: { width: number; height: number } | undefined;
}

/**
 * The size to render, inside the model's range.
 *
 * - Both sides given: those pixels.
 * - One side and a ratio: the ratio derives the other side.
 * - One side alone: the other side is the model's default, as engines have
 *   always filled it.
 * - Otherwise: the model's trained area times the quality tier, in the asked
 *   ratio, else the source picture's, else square, on multiples of 64.
 */
export function resolveImageSize(
  request: ImageSizeRequest,
  model: { defaultSidePx: number } & ImageSizeRange,
): { width: number; height: number } {
  const { width, height, aspectRatio } = request;
  let size: { width: number; height: number };
  if (width !== undefined && height !== undefined) {
    size = { width, height };
  } else if (width !== undefined || height !== undefined) {
    const ratio = aspectRatio ? aspectRatioValue(aspectRatio) : undefined;
    size =
      width !== undefined
        ? { width, height: ratio ? toMultiple(width / ratio, FIT_MULTIPLE) : model.defaultSidePx }
        : {
            width: ratio ? toMultiple(height! * ratio, FIT_MULTIPLE) : model.defaultSidePx,
            height: height!,
          };
  } else {
    const area = model.defaultSidePx ** 2 * IMAGE_QUALITY_AREA[request.quality ?? 'standard'];
    const source = request.sourceSize;
    const ratio = aspectRatio
      ? aspectRatioValue(aspectRatio)
      : source && source.width > 0 && source.height > 0
        ? source.width / source.height
        : 1;
    size = {
      width: toMultiple(Math.sqrt(area * ratio)),
      height: toMultiple(Math.sqrt(area / ratio)),
    };
  }
  const fitted = fitImageSizeToRange(size, model);
  return { width: fitted.width ?? size.width, height: fitted.height ?? size.height };
}
