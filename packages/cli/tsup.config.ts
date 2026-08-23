import { defineConfig } from 'tsup';
import { stripSourcemapCommentsFromBuild } from '../../scripts/strip-sourcemap-comments.mjs';

export default defineConfig({
  // Keep a dependency-free launcher in front of the command implementation.
  // It establishes NODE_ENV before Ink can load react-reconciler; otherwise
  // React's development renderer retains a PerformanceMeasure per component
  // render and a long streaming session eventually exhausts V8's heap.
  //
  // The TUI is a separate entry so the command implementation can lazily
  // import it — React/Ink only load when the TUI actually launches. These
  // imports deliberately use runtime variables at their call sites: with
  // splitting disabled, a literal import() is bundled back into its caller.
  // Same shape for the handboek exporter: the squisq render stack (incl.
  // the multi-MB standalone player bundle) loads only when `gezel
  // handboek export` actually runs — and for the knowledge commands, which
  // pull @bendyline/gezel-knowledge (sqlite-vec, and transformers on build).
  entry: {
    'bin/gezel': 'src/bin/gezel-launcher.ts',
    'bin/gezel-main': 'src/bin/gezel.ts',
    'tui/index': 'src/tui/index.tsx',
    'handboek-export': 'src/handboek-export.ts',
    'knowledge-command': 'src/knowledge-command.ts',
    'app-command': 'src/app-command.ts',
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
  onSuccess: () => stripSourcemapCommentsFromBuild(),
});
