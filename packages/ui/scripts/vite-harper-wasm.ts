/**
 * Publish harper.js's WASM engine beside the gezel UI bundle.
 *
 * Proofing (spelling/grammar) is an opt-in *host* capability in squisq:
 * `harper.js` is an optional peer dependency reached only through a
 * dynamic `import('harper.js')`, and the host is responsible for serving
 * the engine binary same-origin and pointing a provider at it. There is
 * no CDN fallback — gezel is local-first, so the bytes ship with us.
 *
 * This plugin is the gezel analog of the squisq demo site's
 * `harperCorePlugin` (packages/site/vite.config.ts over in that repo):
 * it serves `/harper/*` in dev/preview with the correct MIME and copies
 * the binaries into `dist/` on build, from where they ride into
 * `service/dist/ui/` and `app.asar.unpacked/dist/ui/` with the rest of
 * the UI bundle.
 *
 * Two things here were learned the hard way and must not be "simplified":
 *
 *  - BOTH binaries ship. The full engine derives the slim binary's URL
 *    from its own by filename substitution and loads the pair; serving
 *    only the file `wasmUrl` names produces a 404 inside the worker.
 *  - The MIME must be `application/wasm`. A dev-server SPA fallback that
 *    answers a missing `.wasm` with `200 text/html` surfaces as a
 *    confusing WASM compile error rather than a clean 404.
 *
 * The binaries are copied at build time rather than committed under
 * `public/`: they are ~31 MB of generated artifact that belongs to a
 * pinned dependency, not to this repository.
 */
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Connect, Plugin } from 'vite';

/**
 * harper's bundler-asset entry points, which we deliberately cut out.
 *
 * `harper.js/binary` is the provider's fallback for a host that supplies
 * no `wasmUrl`. It locates the engine with
 * `new URL('harper_wasm_bg.wasm', import.meta.url)`, which Vite resolves
 * at build time and emits as a *content-hashed* asset — a second 15.8 MB
 * copy of a binary we already publish under `/harper/`.
 *
 * That copy is not merely redundant, it cannot work: the engine finds
 * its slim sibling by literal string substitution on the full binary's
 * URL (`replace('harper_wasm_bg.wasm', 'harper_wasm_slim_bg.wasm')`),
 * and a hashed name contains no such substring. Real filenames served
 * side by side are the only layout the engine can load.
 *
 * Gezel always passes `wasmUrl`, so this branch is dead code that costs
 * 15.8 MB in every installer. Replacing it with a throwing stub drops
 * the asset and turns any future host wiring that forgets `wasmUrl`
 * into a legible error instead of a silently half-loaded engine.
 */
const STUBBED_ENTRIES: ReadonlyArray<string> = ['harper.js/binary', 'harper.js/slimBinary'];

const STUB_MODULE_ID = '\0gezel-harper-binary-stub';

const STUB_SOURCE = `
const unavailable = () => {
  throw new Error(
    'harper.js bundler-resolved binaries are not shipped by gezel — the engine is served ' +
      'from /harper/. Pass wasmUrl to createHarperProofingProvider.',
  );
};
export const binary = { get value() { return unavailable(); } };
export const slimBinary = binary;
`;

/** Served path → file name inside `harper.js/dist` (or `LICENSE` at its root). */
const PUBLISHED_FILES: ReadonlyArray<readonly [servedPath: string, packageRelative: string]> = [
  ['/harper/harper_wasm_bg.wasm', 'dist/harper_wasm_bg.wasm'],
  ['/harper/harper_wasm_slim_bg.wasm', 'dist/harper_wasm_slim_bg.wasm'],
  ['/harper/LICENSE.txt', 'LICENSE'],
];

/**
 * Locate the installed `harper.js` package root.
 *
 * Deliberately a directory walk and not `require.resolve('harper.js')`:
 * harper's `exports` map declares only an `import` condition and no
 * `./package.json` subpath, so every by-string resolution from a CJS
 * context throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. Walking up from the
 * Vite root finds both the package-local copy pnpm links for a direct
 * dependency and any hoisted one.
 */
function findHarperRoot(from: string): string {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, 'node_modules', 'harper.js');
    if (existsSync(join(candidate, 'dist', 'harper_wasm_bg.wasm'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `harper.js not found above ${from}. It carries the proofing engine and is a direct dependency of @bendyline/gezel-ui — run \`pnpm deps:install\` before building the UI.`,
  );
}

export function harperWasmPlugin(): Plugin {
  let published = new Map<string, string>();

  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const pathname = req.url?.split('?', 1)[0] ?? '';
    const file = published.get(pathname);
    if (!file) return next();
    res.setHeader('Content-Length', statSync(file).size);
    res.setHeader(
      'Content-Type',
      pathname.endsWith('.wasm') ? 'application/wasm' : 'text/plain; charset=utf-8',
    );
    createReadStream(file).pipe(res);
  };

  return {
    name: 'gezel-harper-wasm',
    // 'pre' so the stub below is seen before Vite's own resolver turns
    // `harper.js/binary` into a real module and emits its WASM asset.
    enforce: 'pre',
    resolveId(source) {
      return STUBBED_ENTRIES.includes(source) ? STUB_MODULE_ID : null;
    },
    load(id) {
      return id === STUB_MODULE_ID ? STUB_SOURCE : null;
    },
    configResolved(config) {
      const root = findHarperRoot(config.root);
      published = new Map(
        PUBLISHED_FILES.map(([servedPath, packageRelative]) => [
          servedPath,
          join(root, ...packageRelative.split('/')),
        ]),
      );
    },
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
    writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) return;
      for (const [servedPath, source] of published) {
        const destination = join(outDir, ...servedPath.slice(1).split('/'));
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination);
      }
    },
  };
}
