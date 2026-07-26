import { defineConfig } from 'tsup';

export default defineConfig({
  // The TUI is a separate entry so the default `gezel` command can lazily
  // `import('../tui/index.js')` — React/Ink only load when the TUI launches.
  // Same shape for the handboek exporter: the squisq render stack (incl.
  // the multi-MB standalone player bundle) loads only when `gezel
  // handboek export` actually runs.
  entry: {
    'bin/gezel': 'src/bin/gezel.ts',
    'tui/index': 'src/tui/index.tsx',
    'handboek-export': 'src/handboek-export.ts',
  },
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  // Automatic JSX runtime (react/jsx-runtime) for the Ink components.
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
  banner: { js: '#!/usr/bin/env node' },
});
