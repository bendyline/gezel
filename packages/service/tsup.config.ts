import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';
import { stageServiceFontLegalBundle } from '../../scripts/service-font-legal.mjs';
import { stripSourcemapCommentsFromBuild } from '../../scripts/strip-sourcemap-comments.mjs';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    gezapp: 'src/gezapp-entry.ts',
    'bin/gezeld': 'src/bin/gezeld.ts',
    // Spawned as a separate process by sandbox-convert.ts to parse untrusted
    // attachments in isolation; must exist as its own file, not bundled into
    // index.js. squisq stays external (see below), so this stays small.
    'index-store/convert-worker': 'src/index-store/convert-worker.ts',
    // Loaded as a worker_thread by memory/embeddings.ts so ONNX embedding
    // inference runs off the Electron main thread; must exist as its own file
    // for `new Worker(...)` to resolve at runtime.
    'memory/embed-worker': 'src/memory/embed-worker.ts',
    // Sibling worker for CLIP image embeddings (+ the face lane's ONNX
    // sessions). Separate from embed-worker so the two modalities' models,
    // memory budgets, and crash accounting stay independent.
    'memory/image-embed-worker': 'src/memory/image-embed-worker.ts',
    // Deterministic workspace file/classification/symbol/SQLite indexing is
    // CPU-heavy on large repositories. Keep it off the daemon event loop (and
    // therefore off Electron's main thread in embedded dev mode).
    'index-store/static-index-worker': 'src/index-store/static-index-worker.ts',
    // Settings previews context admission for every installed GGUF. Tokenizer
    // metadata can be enormous, so the first inspection must not run on the
    // embedded Electron main thread; subsequent polls hit the parent cache.
    'providers/llama-cpp/gguf-metadata-worker': 'src/providers/llama-cpp/gguf-metadata-worker.ts',
    // Owns every knowledge-catalog SQLite connection: CatalogHandle is
    // synchronous (node:sqlite), so shard scans must run off the daemon
    // loop (docs/gezk-format.md).
    'knowledge/search-worker': 'src/knowledge/search-worker.ts',
    // Standalone subpath (`@bendyline/gezel-service/handboek`) so the CLI's
    // static-site export can run the documentation engine without importing
    // the whole daemon.
    handboek: 'src/handboek/engine.ts',
  },
  format: ['esm'],
  // Only the package's two public import surfaces need bundled declarations.
  // Passing every executable entry to rollup-plugin-dts also makes its worker
  // typecheck the daemon and all six internal workers as independent roots.
  // Those 13-byte `export {}` worker declarations are not published APIs and
  // can push Node's isolated worker heap over its limit on memory-constrained
  // builds.
  dts: {
    entry: {
      index: 'src/index.ts',
      gezapp: 'src/gezapp-entry.ts',
      handboek: 'src/handboek/engine.ts',
    },
  },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  banner: { js: '#!/usr/bin/env node' },
  // `@github/copilot-sdk` is installed at runtime into
  // `~/.gezel/system-toolsets/@github__copilot-sdk@<ver>/` (see
  // system-toolsets manifest + bootstrap). In dev it's available as a
  // devDependency and we fall back to that via a bare `await import(...)`,
  // but we never want it bundled — the resolved path lives on the user's
  // disk, not inside the Electron asar.
  //
  // `typescript` is imported by `scripts/meta.ts` to parse the `meta`
  // export from a script file without executing it. Bundling TS's own
  // source trips tsup's ESM converter — TS uses dynamic `require('fs')`
  // internally, which ESM refuses. Keep it external; the daemon loads it
  // from `node_modules/typescript` at runtime.
  //
  // `undici` is used by sd-cpp / image-gen for a custom dispatcher that
  // disables Node's default 5-min `headersTimeout`/`bodyTimeout` — long
  // diffusion runs hold the loopback HTTP request open well past 5
  // minutes. Same reason as `typescript`: undici uses dynamic `require`
  // calls internally that tsup's ESM converter can't bundle. Loaded
  // from node_modules at runtime instead.
  // `sqlite-vec` ships a prebuilt loadable extension binary and resolves its
  // path via `getLoadablePath()` relative to its own package dir on disk —
  // bundling it would break that resolution. Keep it external; loaded from
  // node_modules at runtime. (`node:sqlite` is a builtin, already external.)
  // `node-pty` is an optional native terminal adapter, dynamically imported
  // only on the first terminal command. Keep that import external so the
  // service entrypoint can load when optional dependencies were omitted.
  // squisq (document import/export) + its XML polyfill are loaded from
  // node_modules at runtime. squisq is large and has its own dynamic-require
  // internals (jszip, pdfjs-dist); bundling it into the daemon is both wasteful
  // and fragile. `@xmldom/xmldom` backs the DOMParser polyfill the DOCX importer
  // needs under node (no browser DOMParser global).
  external: [
    '@github/copilot-sdk',
    'typescript',
    'undici',
    'sqlite-vec',
    'node-pty',
    '@xmldom/xmldom',
    /^@bendyline\/squisq/,
    // Mail stack: imapflow (IMAP client) + mailparser (MIME) have dynamic
    // require internals (iconv-lite encodings, libmime); load from node_modules.
    'imapflow',
    'mailparser',
  ],
  // Copy non-TS assets that ship alongside the bundle. The Python file
  // is the wrapped MLX server (Phase 2) — spawned at runtime against
  // the user's mlx venv. tsup doesn't copy non-TS source by default;
  // we handle it explicitly here so a single `pnpm build` produces a
  // ready-to-run dist tree. Done as an inline function (not a `node -e`
  // shell string) because PowerShell 5.1 mangles forward slashes inside
  // embedded JS string literals when invoking native commands.
  onSuccess: async () => {
    cpSync('src/providers/mlx/python', 'dist/providers/mlx/python', { recursive: true });
    // Handboek content: the hand-curated documentation tree lives at the
    // repo root (docs/handboek/) so humans author it next to the other
    // docs, and ships inside the service package so the engine can serve
    // it from any install (findHandboekContent() probes dist/handboek-content
    // first). Unlike the UI copy below this one is a hard requirement —
    // a service without its documentation is a packaging bug.
    const handboekSrc = resolve(__dirname, '..', '..', 'docs', 'handboek');
    if (!existsSync(handboekSrc)) {
      throw new Error(`handboek content missing at ${handboekSrc} — docs/handboek must exist`);
    }
    cpSync(handboekSrc, 'dist/handboek-content', { recursive: true });
    // The bundled diffusers video server (`gezel_video_server.py`),
    // spawned at runtime against the user's `video` venv. Same rationale
    // as the MLX python copy above.
    cpSync('src/providers/video/python', 'dist/providers/video/python', { recursive: true });

    // Stage the workspace UI bundle into `dist/ui/` so an installed
    // service (e.g. the Node-only CLI distribution) can serve the browser
    // UI: `findBundledUi()` in src/bin/gezeld.ts probes `<bin>/../ui` first,
    // which resolves to `dist/ui` once bundled. The Electron app stages its
    // own copy separately (packages/app/tsup.config.ts); this is the copy
    // that ships inside the published @bendyline/gezel-service package.
    // Best-effort: a daemon with no UI bundle still runs headless (the
    // server falls back to a placeholder page), so a missing bundle in a
    // headless/CI build is a warning, not a failure.
    const uiSrc = resolve(__dirname, '..', 'ui', 'dist');
    if (existsSync(uiSrc)) {
      cpSync(uiSrc, 'dist/ui', { recursive: true });
    } else {
      console.warn(
        `[tsup] no UI bundle at ${uiSrc} — run \`pnpm --filter @bendyline/gezel-ui build\` before building the service to ship the browser UI (\`gezel start --web\`). The daemon still runs headless without it.`,
      );
    }
    // npm publishes this dist/ui copy independently of Electron's staged
    // resources/licenses tree. Keep the notice and every font's canonical
    // legal text beside it so that distribution channel is self-contained.
    await stageServiceFontLegalBundle();
    await stripSourcemapCommentsFromBuild();
  },
});
