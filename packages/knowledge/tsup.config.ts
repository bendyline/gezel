import { defineConfig } from 'tsup';
import { stripSourcemapCommentsFromBuild } from '../../scripts/strip-sourcemap-comments.mjs';

export default defineConfig({
  // `./browser` is the pure subset (chunker, profiles, FTS query helpers);
  // `.` loads node:sqlite on import.
  entry: ['src/index.ts', 'src/browser.ts'],
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
