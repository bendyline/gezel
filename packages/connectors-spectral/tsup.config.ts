import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/run-action.ts'],
  format: ['cjs'],
  target: 'node18',
  // No `dts`. Nothing type-imports this package: the service resolves
  // `run-action` and SPAWNS it. Declaration emit would also have to name
  // types out of the vendored components' transitive axios, which is not
  // portable.
  clean: true,
  // Bundle the vendored components + shims; keep spectral external (resolved
  // from this package's own node_modules at runtime).
  external: ['@prismatic-io/spectral'],
});
