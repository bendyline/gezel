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
  resolve: {
    dedupe: ['react', 'react-dom'],
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
