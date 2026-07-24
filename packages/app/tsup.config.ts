import { spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    main: 'src/main.ts',
    // Install-time CLI invoked by per-platform installers (NSIS / PKG
    // postinstall / deb-rpm afterInstall) via `ELECTRON_RUN_AS_NODE=1` on
    // the bundled Electron exe. Bundled as a sibling to main.js so the
    // installer can reference it at a stable path.
    'extract-service-bundle': 'src/extract-service-bundle.ts',
  },
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  splitting: false,
  platform: 'node',
  // `@bendyline/gezel-service` is a devDep rather than a prod dep (see the
  // CLAUDE.md gotcha about the embedded fallback loading from the unpacked
  // service-bundle) — but tsup only auto-externalizes prod deps, so the
  // dev-mode `import('@bendyline/gezel-service')` fallback in supervisor's
  // startEmbeddedRaw would otherwise pull the entire service tree
  // (including native .node addons) into the bundled main.js. Explicit
  // external keeps it as a runtime dynamic import.
  external: ['electron', '@bendyline/gezel-service'],
  onSuccess: async () => {
    // Copy the plain CJS preload into dist/. Electron's sandboxed preloads
    // need to be CJS, and it's a tiny file — not worth running it through
    // the TS compiler.
    cpSync('src/preload.cjs', 'dist/preload.cjs');

    // Stage the workspace UI bundle into `dist/ui/`. The Electron main
    // process's `resolveBundledUi` looks for `__dirname/ui/index.html`
    // first; that path resolves to `app.asar.unpacked/dist/ui/` after the
    // supervisor's asar→unpacked rewrite. Without this step the packaged
    // app falls through to the "web UI bundle was not included" placeholder
    // even when `pnpm --filter @bendyline/gezel-ui build` ran fine, because
    // electron-builder only sees `dist/`-relative paths in its files glob
    // and the UI lives at `../ui/dist/` in the workspace.
    const uiSrc = resolve(__dirname, '..', 'ui', 'dist');
    if (existsSync(uiSrc)) {
      cpSync(uiSrc, 'dist/ui', { recursive: true });
    } else {
      console.warn(
        `[tsup] no UI bundle at ${uiSrc} — did you run \`pnpm --filter @bendyline/gezel-ui build\`? The packaged app will show the no-UI placeholder.`,
      );
    }

    // Download + verify the pinned pnpm binary into dist/pnpm-bundle/.
    // Honors GEZEL_PNPM_SKIP=1 for offline dev; the supervisor's
    // extract-pnpm step treats a missing bundle as "fall back to system
    // pnpm" in dev.
    const pnpmRes = spawnSync(process.execPath, ['scripts/fetch-pnpm.mjs'], {
      stdio: 'inherit',
    });
    if (pnpmRes.status !== 0) {
      if (process.env.GEZEL_PNPM_SKIP === '1') {
        console.warn('[tsup] fetch-pnpm skipped (GEZEL_PNPM_SKIP=1)');
      } else {
        throw new Error('[tsup] fetch-pnpm failed — see output above');
      }
    }

    // Same pattern for the pinned Node.js binary, into dist/node-bundle/.
    // The supervisor's extract-node step lays it down at
    // `~/.gezel/bin/node[.exe]` on first launch and exports
    // `GEZEL_NODE_PATH` for the sandbox runner. GEZEL_NODE_SKIP=1 in dev
    // falls back to system node.
    const nodeRes = spawnSync(process.execPath, ['scripts/fetch-node.mjs'], {
      stdio: 'inherit',
    });
    if (nodeRes.status !== 0) {
      if (process.env.GEZEL_NODE_SKIP === '1') {
        console.warn('[tsup] fetch-node skipped (GEZEL_NODE_SKIP=1)');
      } else {
        throw new Error('[tsup] fetch-node failed — see output above');
      }
    }
  },
});
