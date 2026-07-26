import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // With `pnpm link:squisq` active, the squisq packages resolve to the
  // sibling checkout — whose own workspace carries react 18 for its dev
  // tooling. Without dedupe, their bare `import "react"` resolves THERE,
  // bundling a second React whose 18-shaped contexts react-dom 19
  // rejects at render time ("Element type is invalid … got: object",
  // minified React error #130 — the broken-Handboek-tab incident).
  // Dedupe pins every react import, linked or installed, to this
  // package's copy.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  // `@bendyline/squisq-video-react` spawns its encoder as a module
  // worker (`new Worker(new URL(...), { type: 'module' })`), which
  // Vite can only bundle when its worker format is `'es'`. The default
  // `'iife'` rejects code-split workers and crashes the production
  // build with "Invalid value 'iife' for option 'worker.format'".
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
});
