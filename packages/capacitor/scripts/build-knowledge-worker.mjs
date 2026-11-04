/**
 * Bundle dist/knowledge-worker.js: the daemon's catalog host over the
 * unmodified catalog reader (worker/knowledge.ts), everything inlined.
 * esbuild directly rather than tsup, which marks node:* builtins external
 * before any plugin or alias can swap in the worker's stand-ins.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
// tsup's own esbuild, so this script adds no dependency.
const require = createRequire(createRequire(import.meta.url).resolve('tsup'));
const { build } = require('esbuild');

const { metafile } = await build({
  entryPoints: { 'knowledge-worker': here('worker/knowledge.ts') },
  outdir: here('dist'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  logLevel: 'warning',
  metafile: true,
  inject: [here('worker/globals.ts')],
  plugins: [
    {
      name: 'knowledge-worker',
      setup(b) {
        b.onResolve({ filter: /^@bendyline\/gezel-knowledge$/ }, () => ({
          path: here('worker/reader.ts'),
        }));
        // The reader's single node:sqlite loader becomes sqlite-wasm.
        b.onResolve({ filter: /format\/node-sqlite(\.js)?$/ }, () => ({
          path: here('src/knowledge/sqlite-sync.ts'),
        }));
        b.onResolve({ filter: /^(node:)?(fs|path|url|zlib)$/ }, (args) => ({
          path: here(`src/knowledge/node/${args.path.replace(/^node:/, '')}.ts`),
        }));
      },
    },
  ],
});
// Names the packages bundled in, for scripts/stage-bundled-licenses.mjs.
writeFileSync(here('dist/metafile-worker.json'), JSON.stringify(metafile));
