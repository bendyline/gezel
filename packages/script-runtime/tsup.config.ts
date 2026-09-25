import { defineConfig } from 'tsup';
import { stripSourcemapCommentsFromBuild } from '../../scripts/strip-sourcemap-comments.mjs';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/quickjs.ts',
    'src/meta.ts',
    'src/source.ts',
    'src/compile.ts',
    'src/web-worker.ts',
    'src/worker-protocol.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  splitting: false,
  onSuccess: () => stripSourcemapCommentsFromBuild(),
});
