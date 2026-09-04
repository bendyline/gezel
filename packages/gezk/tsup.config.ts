import { defineConfig } from 'tsup';
import { stripSourcemapCommentsFromBuild } from '../../scripts/strip-sourcemap-comments.mjs';

export default defineConfig({
  // `.` is browser-safe (zod + pure functions); `./node` adds the pieces that
  // need node:crypto / node:fs (content hashes, Ed25519 signing, file digests).
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  onSuccess: () => stripSourcemapCommentsFromBuild(),
});
