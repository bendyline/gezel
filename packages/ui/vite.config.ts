import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { type Connect, type Plugin, defineConfig } from 'vite';

const dirname = path.dirname(fileURLToPath(import.meta.url));

const crossOriginHeaders = {
  // Squisq's GIF encoder and MP4 fallback use SharedArrayBuffer.
  // `credentialless` preserves blob-backed frame capture and public media.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

/**
 * Publish the exact-pinned ffmpeg.wasm core beside the UI.
 *
 * Squisq deliberately refuses its historical unpkg fallback: GIF export must
 * remain offline-capable and must not fetch executable code at click time.
 * Production is served from this Vite output by gezeld; dev/preview use the
 * same URLs through this plugin's middleware.
 */
function ffmpegCorePlugin(): Plugin {
  const coreDir = path.resolve(dirname, 'node_modules/@ffmpeg/core/dist/esm');
  const videoReactDir = path.resolve(dirname, 'node_modules/@bendyline/squisq-video-react');
  const publishedFiles = new Map<string, string>([
    ['/ffmpeg-core/ffmpeg-core.js', path.join(coreDir, 'ffmpeg-core.js')],
    ['/ffmpeg-core/ffmpeg-core.wasm', path.join(coreDir, 'ffmpeg-core.wasm')],
    ['/ffmpeg-core/NOTICE.md', path.join(videoReactDir, 'NOTICE.md')],
    ['/ffmpeg-core/COPYING.GPL-2.0.txt', path.join(videoReactDir, 'COPYING.GPL-2.0.txt')],
  ]);

  const servePublishedFile: Connect.NextHandleFunction = (req, res, next) => {
    const pathname = req.url?.split('?', 1)[0] ?? '';
    const sourcePath = publishedFiles.get(pathname);
    if (!sourcePath || !fs.existsSync(sourcePath)) return next();

    const stat = fs.statSync(sourcePath);
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Content-Type',
      pathname.endsWith('.wasm')
        ? 'application/wasm'
        : pathname.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : pathname.endsWith('.md')
            ? 'text/markdown; charset=utf-8'
            : 'text/plain; charset=utf-8',
    );
    fs.createReadStream(sourcePath).pipe(res);
  };

  return {
    name: 'gezel-ffmpeg-core',
    configureServer(server) {
      server.middlewares.use(servePublishedFile);
    },
    configurePreviewServer(server) {
      server.middlewares.use(servePublishedFile);
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve(dirname, 'dist');
      for (const [publicPath, sourcePath] of publishedFiles) {
        const destinationPath = path.join(outDir, ...publicPath.slice(1).split('/'));
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(sourcePath, destinationPath);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), ffmpegCorePlugin()],
  // With `pnpm link:squisq` active, the squisq packages resolve to the
  // sibling checkout — whose own workspace carries react 18 for its dev
  // tooling. Without dedupe, their bare `import "react"` resolves THERE,
  // bundling a second React whose 18-shaped contexts react-dom 19
  // rejects at render time ("Element type is invalid … got: object",
  // minified React error #130 — the broken-Handboek-tab incident).
  // Dedupe pins every react import, linked or installed, to this
  // package's copy.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  // `@bendyline/squisq-video-react` spawns its encoder as a module
  // worker (`new Worker(new URL(...), { type: 'module' })`), which
  // Vite can only bundle when its worker format is `'es'`. The default
  // `'iife'` rejects code-split workers and crashes the production
  // build with "Invalid value 'iife' for option 'worker.format'".
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    headers: crossOriginHeaders,
  },
  preview: {
    headers: crossOriginHeaders,
  },
});
