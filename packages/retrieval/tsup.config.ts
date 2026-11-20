import { defineConfig } from 'tsup';
import { stripSourcemapCommentsFromBuild } from '../../scripts/strip-sourcemap-comments.mjs';

export default defineConfig({
  // Both entries are browser-safe: they run in a Web Worker or a mobile
  // WebView as well as in Node (src/browser.test.ts walks the import graph).
  entry: ['src/index.ts', 'src/sqlite-wasm.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  onSuccess: () => stripSourcemapCommentsFromBuild(),
});
