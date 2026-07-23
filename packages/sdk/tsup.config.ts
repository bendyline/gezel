import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/checks.ts', 'src/stores.ts'],
  format: ['esm'],
  // `resolve` inlines the @bendyline/gezel/checks types into checks.d.ts —
  // without it the dts keeps an external `export * from '@bendyline/gezel/checks'`
  // that neither the sandbox nor Monaco can resolve.
  dts: { resolve: [/^@bendyline\/gezel(?:\/|$)/] },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  // The checks entry re-exports @bendyline/gezel/checks; bundle it in so
  // the SDK dist stays self-contained when vendored into script sandboxes
  // (sandboxes have no node_modules beyond the vendored SDK itself).
  noExternal: ['@bendyline/gezel'],
});
