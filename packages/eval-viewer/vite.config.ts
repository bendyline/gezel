import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';
import { buildIndex } from './scripts/scan-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const runsDir = resolve(repoRoot, 'evals', 'runs');

const mimeByExt: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

// Serve files under /runs/* directly from the repo's evals/runs/* tree.
// We do this with a tiny middleware rather than a symlink so the viewer
// works on Windows + so we can decline traversal attempts cleanly.
function evalRunsServer(): Plugin {
  return {
    name: 'eval-runs-server',
    configureServer(server) {
      server.middlewares.use('/runs', (req, res, next) => {
        try {
          const url = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
          if (url.includes('\0') || url.split('/').includes('..')) {
            res.statusCode = 400;
            res.end('bad path');
            return;
          }
          const target = resolve(runsDir, `.${url}`);
          const rel = relative(runsDir, target);
          if (rel.startsWith('..') || isAbsolute(rel)) {
            res.statusCode = 403;
            res.end('forbidden');
            return;
          }
          if (!existsSync(target)) {
            // 404 explicitly — don't fall through to Vite's SPA fallback,
            // which would serve index.html and confuse the fetch() callers.
            res.statusCode = 404;
            res.end('not found');
            return;
          }
          const st = statSync(target);
          if (st.isDirectory()) {
            res.statusCode = 404;
            res.end('directory listing not exposed');
            return;
          }
          const mime = mimeByExt[extname(target).toLowerCase()] ?? 'application/octet-stream';
          res.setHeader('Content-Type', mime);
          res.setHeader('Content-Length', String(st.size));
          createReadStream(target).pipe(res);
        } catch (err) {
          next(err as Error);
        }
      });
    },
  };
}

// Serve a freshly-scanned RunsIndex at /api/index so the open page can
// poll for live updates — newly-started, finished, and newly-scored
// trials all show up without a reload. A finished-trial cache (keyed by
// result.json mtime, held in this closure) keeps each poll O(running
// trials) rather than re-reading the whole history.
function evalIndexApi(): Plugin {
  const cache = new Map<string, { mtimeMs: number; record: unknown }>();
  return {
    name: 'eval-index-api',
    configureServer(server) {
      server.middlewares.use('/api/index', (_req, res) => {
        try {
          const index = buildIndex({ runsRoot: runsDir, repoRoot, cache });
          const body = JSON.stringify(index);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), evalRunsServer(), evalIndexApi()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5180,
    fs: {
      // Allow reading the repo root so the dev server can serve /runs/*
      // from evals/runs/ via the middleware above.
      allow: [repoRoot],
    },
  },
});
