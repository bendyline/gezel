import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/run-action.ts'],
  format: ['cjs'],
  target: 'node18',
  clean: true,
  // Bundle the vendored components + shims; keep spectral external (resolved
  // from this package's own node_modules at runtime).
  external: ['@prismatic-io/spectral'],
});
