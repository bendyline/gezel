import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { fontPreloadPlugin } from './scripts/vite-font-preload.js';
import { harperWasmPlugin } from './scripts/vite-harper-wasm.js';
import { noBrowserFfmpegPlugin } from './scripts/vite-no-browser-ffmpeg.js';
import { reactWithCompiler } from './scripts/vite-react.js';
import { routeGraphPlugin } from './scripts/vite-route-graph.js';

export default defineConfig({
  plugins: [
    ...reactWithCompiler(import.meta.dirname),
    harperWasmPlugin(),
    noBrowserFfmpegPlugin(),
    routeGraphPlugin(),
    // The interface face and the reading face the shell draws first.
    fontPreloadPlugin(['hanken-grotesk-400', 'pt-serif-400']),
    {
      name: 'local-startup-dev-assets',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const file = request.url?.split('?')[0];
          if (!file || !/^\/startup\/(?:assets\/)?[a-zA-Z0-9_.-]+\.(js|css|png|woff2)$/.test(file))
            return next();
          void readFile(resolve('dist', file.slice(1))).then(
            (content) => {
              response.setHeader(
                'Content-Type',
                file.endsWith('.js')
                  ? 'text/javascript'
                  : file.endsWith('.css')
                    ? 'text/css'
                    : file.endsWith('.png')
                      ? 'image/png'
                      : 'font/woff2',
              );
              response.end(content);
            },
            () => next(),
          );
        });
      },
    },
  ],
  // With `pnpm link:squisq` active, the squisq packages resolve to the
  // sibling checkout — whose own workspace carries react 18 for its dev
  // tooling. Without dedupe, their bare `import "react"` resolves THERE,
  // bundling a second React whose 18-shaped contexts react-dom 19
  // rejects at render time ("Element type is invalid … got: object",
  // minified React error #130 — the broken-Handboek-tab incident).
  // Dedupe pins every react import, linked or installed, to this
  // package's copy.
  // The client imports its schemas from `@bendyline/gezel/schemas`, and
  // this app imports `@bendyline/gezel`, whose browser entry re-exports the
  // same schemas. Core builds each entry standalone and bundlers cannot
  // prove zod schema construction side-effect free, so the two entries put
  // every schema in the startup bundle twice (~58 KiB gzip). Pointing the
  // subpath at the browser entry keeps one copy.
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [{ find: /^@bendyline\/gezel\/schemas$/, replacement: '@bendyline/gezel' }],
  },
  // IronCalc's wasm-bindgen shim is reached only after Squisq asks for a
  // formula session. Pre-bundling it would break the explicit wasm asset URL
  // supplied by our host factory and make dev differ from the packaged UI.
  optimizeDeps: {
    exclude: ['@bendyline/squisq-calc', '@ironcalc/wasm'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      output: {
        // Core's build splits its shared code into chunks. Left to itself,
        // Rolldown then cannot merge the shell's small shared modules into the
        // entry without a circular chunk import, and the startup graph grows
        // from 42 to 53 requests at the same byte size. Keeping core in one
        // chunk, as its unsplit browser entry was, restores the old shape.
        // A linked squisq checkout (`pnpm link:squisq`) has a packages/core
        // too; matching it put all of squisq's core in the startup chunk.
        codeSplitting: {
          groups: [
            // Vendor code in named chunks: an app update that leaves React,
            // the query cache or the editor alone keeps their files, so the
            // browser keeps their cached bytes and compiled code. Only sets the
            // shell uses whole (or that load together) are grouped: a group
            // is one chunk, so grouping a family the shell uses part of would
            // pull the rest into startup.
            {
              name: 'vendor-react',
              // Not react-dom's server and static renderers: only a lazily
              // loaded Help article uses them, and grouped they rode startup.
              test: (id: string) =>
                /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/.test(id) &&
                !/[\\/]react-dom[\\/](?:cjs[\\/]react-dom-)?(?:server|static)/.test(id),
            },
            {
              name: 'vendor-query',
              test: /[\\/]node_modules[\\/]@tanstack[\\/](?:react-query|query-core)[\\/]/,
            },
            {
              name: 'vendor-editor',
              test: /[\\/]node_modules[\\/](?:prosemirror-[^\\/]+|@tiptap[\\/][^\\/]+)[\\/]/,
            },
            {
              name: 'gezel-core',
              test: /(?<![\\/]squisq)[\\/]packages[\\/]core[\\/]dist[\\/]|[\\/]node_modules[\\/]@bendyline[\\/]gezel[\\/]dist[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
