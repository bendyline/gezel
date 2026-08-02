import { defineConfig } from 'tsup';
import { stripSourcemapCommentsFromBuild } from '../../scripts/strip-sourcemap-comments.mjs';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'lint-contracts': 'src/lint-contracts.ts',
    server: 'src/server.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  onSuccess: () => stripSourcemapCommentsFromBuild(),
});
