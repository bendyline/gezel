import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
