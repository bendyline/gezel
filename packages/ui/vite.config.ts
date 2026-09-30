import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { harperWasmPlugin } from './scripts/vite-harper-wasm.js';

export default defineConfig({
  plugins: [react(), harperWasmPlugin()],
  // With `pnpm link:squisq` active, the squisq packages resolve to the
  // sibling checkout — whose own workspace carries react 18 for its dev
  // tooling. Without dedupe, their bare `import "react"` resolves THERE,
  // bundling a second React whose 18-shaped contexts react-dom 19
  // rejects at render time ("Element type is invalid … got: object",
  // minified React error #130 — the broken-Handboek-tab incident).
  // Dedupe pins every react import, linked or installed, to this
  // package's copy.
  // The client imports its schemas from `@bendyline/gezel/schemas`, and
  // this app imports `@bendyline/gezel`, whose browser entry re-exports the
  // same schemas. Core builds each entry standalone and bundlers cannot
  // prove zod schema construction side-effect free, so the two entries put
  // every schema in the startup bundle twice (~58 KiB gzip). Pointing the
  // subpath at the browser entry keeps one copy.
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [{ find: /^@bendyline\/gezel\/schemas$/, replacement: '@bendyline/gezel' }],
  },
  // IronCalc's wasm-bindgen shim is reached only after Squisq asks for a
  // formula session. Pre-bundling it would break the explicit wasm asset URL
  // supplied by our host factory and make dev differ from the packaged UI.
  optimizeDeps: {
    exclude: ['@bendyline/squisq-calc', '@ironcalc/wasm'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
