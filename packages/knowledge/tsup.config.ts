import { defineConfig } from 'tsup';
import { stripSourcemapCommentsFromBuild } from '../../scripts/strip-sourcemap-comments.mjs';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  // sqlite-vec ships a prebuilt loadable extension resolved from its package
  // dir on disk (`getLoadablePath()`); bundling would break that resolution —
  // same rule as the service's index driver. yauzl/yazl stay external for
  // ordinary node_modules loading.
  external: ['sqlite-vec', 'yauzl', 'yazl'],
  onSuccess: () => stripSourcemapCommentsFromBuild(),
});
