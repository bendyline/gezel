/**
 * `@bendyline/gezel-service/media` — multimodal embedding for hosts that
 * build knowledge catalogs (the CLI's `gezel knowledge build`) or measure
 * media retrieval (the media bench), without importing the whole daemon.
 */
export { type CatalogMediaEmbedder, createCatalogMediaEmbedder } from './media/catalog-embedder.js';
export { type FfmpegInfo, locateFfmpeg } from './media/ffmpeg.js';
export {
  MAX_MEDIA_WINDOWS,
  type MediaWindow,
  decodeAudioWindows,
  decodeVideoWindows,
  probeMedia,
} from './media/segment.js';
export {
  type MediaEncoder,
  type MediaModality,
  loadMediaEncoder,
} from './memory/media-embed-core.js';
export {
  ImageDecodeError,
  type RgbImage,
  decodeImage,
  gemmaVisionTargetSize,
  readBoundedImageFile,
  resizeBicubic,
  rgbaToRgb,
} from './memory/image-pixels.js';
