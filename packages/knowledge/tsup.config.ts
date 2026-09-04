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
  // yauzl/yazl stay external for ordinary node_modules loading.
  external: ['yauzl', 'yazl'],
  onSuccess: () => stripSourcemapCommentsFromBuild(),
});
