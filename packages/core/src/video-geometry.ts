/**
 * The shape of each video architecture: how far its VAE compresses a frame
 * and a clip, and how many latent cells make one transformer token. Sizing
 * (which widths, heights and frame counts a model accepts) and memory
 * pricing (how many tokens the transformer attends over) both read it, so a
 * size the generate route accepts is exactly a size the price was made for.
 *
 * Values are the published model configs (`transformer/config.json`,
 * `vae/config.json`), checked 2026-11-09. Pure and browser-safe.
 */
import type { VideoArchitecture, VideoModelFamily } from './schemas/catalog.js';

export interface VideoArchitectureGeometry {
  /** Pixels per latent cell along each side: the VAE's spatial compression. */
  spatialCompression: number;
  /** Frames per latent frame after the first: the VAE's temporal compression. */
  temporalCompression: number;
  /** Latent cells per transformer token along each side. */
  patchSize: number;
  /** The transformer's hidden width. */
  hiddenSize: number;
  /**
   * The VAE decodes a clip a few frames at a time, carrying a cache forward
   * (Wan's causal VAE), so its decode memory follows the frame size. Without
   * it the whole clip decodes at once and follows frames times pixels.
   */
  causalDecode: boolean;
}

export const VIDEO_ARCHITECTURES: Readonly<Record<VideoArchitecture, VideoArchitectureGeometry>> = {
  // Lightricks/LTX-Video-0.9.7-dev: 32 heads x 128, VAE 32x / 8x, patch 1.
  'ltx-video-0.9': {
    spatialCompression: 32,
    temporalCompression: 8,
    patchSize: 1,
    hiddenSize: 4096,
    causalDecode: false,
  },
  // diffusers/LTX-2.3-Distilled-Diffusers: video stream 32 x 128, VAE 32x / 8x, patch 1.
  'ltx-2': {
    spatialCompression: 32,
    temporalCompression: 8,
    patchSize: 1,
    hiddenSize: 4096,
    causalDecode: false,
  },
  // Wan-AI/Wan2.2-TI2V-5B-Diffusers: 24 x 128, Wan2.2 VAE 16x / 4x, patch 2.
  'wan2.2-ti2v-5b': {
    spatialCompression: 16,
    temporalCompression: 4,
    patchSize: 2,
    hiddenSize: 3072,
    causalDecode: true,
  },
  // Wan-AI/Wan2.1-T2V-1.3B-Diffusers: 12 x 128, Wan2.1 VAE 8x / 4x, patch 2.
  'wan2.1-1.3b': {
    spatialCompression: 8,
    temporalCompression: 4,
    patchSize: 2,
    hiddenSize: 1536,
    causalDecode: true,
  },
  // robbyant/lingbot-video-dense-1.3b: 16 x 128 (axes 32+48+48), Wan2.1 VAE, patch 2.
  'lingbot-video-1.3b': {
    spatialCompression: 8,
    temporalCompression: 4,
    patchSize: 2,
    hiddenSize: 2048,
    causalDecode: true,
  },
};

/** The architecture an entry that names none was built on: every such entry predates the field. */
const FAMILY_DEFAULT_ARCHITECTURE: Readonly<Record<VideoModelFamily, VideoArchitecture>> = {
  ltx: 'ltx-video-0.9',
  ltx2: 'ltx-2',
  wan: 'wan2.2-ti2v-5b',
  lingbot: 'lingbot-video-1.3b',
};

export function resolveVideoArchitecture(model: {
  family: VideoModelFamily;
  architecture?: VideoArchitecture | undefined;
}): VideoArchitecture {
  return model.architecture ?? FAMILY_DEFAULT_ARCHITECTURE[model.family];
}

export function videoGeometry(model: {
  family: VideoModelFamily;
  architecture?: VideoArchitecture | undefined;
}): VideoArchitectureGeometry {
  return VIDEO_ARCHITECTURES[resolveVideoArchitecture(model)];
}

export interface VideoRenderSize {
  width: number;
  height: number;
  numFrames: number;
}

/** Widths and heights must be a multiple of this: one transformer token's span in pixels. */
export function videoSizeMultiple(geo: VideoArchitectureGeometry): number {
  return geo.spatialCompression * geo.patchSize;
}

/** Frame counts the VAE accepts are `step * n + 1`. */
export function videoFrameStep(geo: VideoArchitectureGeometry): number {
  return geo.temporalCompression;
}

export function videoLatentFrames(geo: VideoArchitectureGeometry, numFrames: number): number {
  return Math.floor((Math.max(1, numFrames) - 1) / geo.temporalCompression) + 1;
}

/** Tokens the transformer attends over for one clip. */
export function videoLatentTokens(geo: VideoArchitectureGeometry, size: VideoRenderSize): number {
  const span = videoSizeMultiple(geo);
  return (
    videoLatentFrames(geo, size.numFrames) *
    Math.ceil(size.height / span) *
    Math.ceil(size.width / span)
  );
}

/** The largest frame count on the VAE's grid at or below `frames`, never below one. */
export function snapVideoFrames(geo: VideoArchitectureGeometry, frames: number): number {
  const step = videoFrameStep(geo);
  return Math.max(1, Math.floor((Math.max(1, frames) - 1) / step) * step + 1);
}

/** The nearest multiple of the token span to `px`, never below one span. */
export function snapVideoSide(geo: VideoArchitectureGeometry, px: number): number {
  const span = videoSizeMultiple(geo);
  return Math.max(span, Math.round(px / span) * span);
}
