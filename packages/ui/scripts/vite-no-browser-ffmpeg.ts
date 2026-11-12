import type { Plugin } from 'vite';

/**
 * Keep ffmpeg.wasm out of the UI build.
 *
 * Squisq's video package can turn an MP4 into a GIF in the browser with
 * `@ffmpeg/ffmpeg`, reached by a dynamic import. Gezel renders video with the
 * ffmpeg installed on the computer and never calls that path, so the code is
 * tree-shaken, but Vite emits the module's worker (`new Worker(new URL(…))`)
 * while transforming it, before tree-shaking runs. The service tarball and
 * the installers then shipped an unreferenced `assets/worker-*.js` naming
 * `https://unpkg.com/@ffmpeg/core@…` (2026-11-11 npm ship audit).
 *
 * A throwing stub keeps the worker out and makes any future caller fail
 * with a plain message instead of fetching code from a CDN.
 */
const STUBBED_ENTRIES: ReadonlyArray<string> = ['@ffmpeg/ffmpeg'];

const STUB_MODULE_ID = '\0gezel-ffmpeg-wasm-stub';

const STUB_SOURCE = `
export class FFmpeg {
  constructor() {
    throw new Error(
      'ffmpeg.wasm is not shipped by gezel: video is rendered by the ffmpeg installed on this computer.',
    );
  }
}
`;

export function noBrowserFfmpegPlugin(): Plugin {
  return {
    name: 'gezel-no-browser-ffmpeg',
    // 'pre' so the stub is seen before Vite's resolver loads the real module
    // and its worker plugin emits the worker chunk.
    enforce: 'pre',
    resolveId(source) {
      return STUBBED_ENTRIES.includes(source) ? STUB_MODULE_ID : null;
    },
    load(id) {
      return id === STUB_MODULE_ID ? STUB_SOURCE : null;
    },
  };
}
