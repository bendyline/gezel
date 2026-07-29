import type { FfmpegWasmLoadConfig } from '@bendyline/squisq-video-react';

const baseUrl = import.meta.env.BASE_URL;

/**
 * Same-origin ffmpeg.wasm core assets emitted by the UI's Vite plugin.
 * Required by Squisq for animated GIFs and browser MP4 fallbacks.
 */
export const GEZEL_FFMPEG_WASM_CONFIG: FfmpegWasmLoadConfig = {
  coreURL: `${baseUrl}ffmpeg-core/ffmpeg-core.js`,
  wasmURL: `${baseUrl}ffmpeg-core/ffmpeg-core.wasm`,
};
