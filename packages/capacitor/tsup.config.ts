import { defineConfig } from 'tsup';

// dist/knowledge-worker.js is built by scripts/build-knowledge-worker.mjs.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  target: 'es2022',
  splitting: false,
  // Names the packages bundled in, for scripts/stage-bundled-licenses.mjs.
  metafile: true,
});
