import { defineConfig } from 'tsup';
import { stripSourcemapCommentsFromBuild } from '../../scripts/strip-sourcemap-comments.mjs';

export default defineConfig({
  entry: ['src/index.ts', 'src/browser.ts', 'src/host.ts', 'src/advanced.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // One error/lifecycle identity across root, browser and host entry points.
  splitting: true,
  onSuccess: () => stripSourcemapCommentsFromBuild(),
});
