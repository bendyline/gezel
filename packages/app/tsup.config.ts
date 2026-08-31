import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    main: 'src/main.ts',
    // Install-time CLI invoked by per-platform installers (NSIS / PKG
    // postinstall / deb-rpm afterInstall). Windows uses the bundled Node
    // runtime; Unix installers currently use Electron's RUN_AS_NODE mode.
    // Bundled as a sibling to main.js so every installer has a stable path.
    'extract-service-bundle': 'src/extract-service-bundle.ts',
    'migrate-legacy-shared': 'src/migrate-legacy-shared.ts',
  },
  format: ['esm'],
  dts: false,
  sourcemap: true,
  // The native runtimes are staged into dist after compilation and contain
  // large third-party trees. On Windows, antivirus/indexing can briefly hold
  // one of those files open; tsup's cleaner uses a single synchronous unlink
  // with no retry, which turns that transient EBUSY into a failed build.
  // Their staging scripts own replacement/cleanup (with Windows-aware retry),
  // so keep tsup focused on the app/UI/service outputs it actually emits.
  clean: ['!pnpm-bundle/**', '!node-bundle/**'],
  target: 'node20',
  splitting: false,
  platform: 'node',
  // esbuild's ESM wrapper for any bundled CommonJS dependency delegates
  // dynamic built-in loads to an in-scope `require`. Native ESM does not
  // provide one, so keep a standard Node createRequire bridge at the bundle
  // boundary instead of relying on Electron's loader implementation.
  banner: {
    js: 'import { createRequire as __gezelCreateRequire } from "node:module"; const require = __gezelCreateRequire(import.meta.url);',
  },
  // These are workspace packages in development, where pnpm exposes them as
  // symlinks. electron-builder deliberately does not follow those workspace
  // links into app.asar, so leaving tsup's dependency auto-externalization in
  // place produces a main.js with bare imports that cannot resolve after
  // installation. Bundle both packages (including their exported subpaths)
  // into the Electron main entry instead.
  noExternal: [/^@bendyline\/gezel(?:\/.*)?$/, /^@bendyline\/gezel-client(?:\/.*)?$/],
  // `@bendyline/gezel-service` is a devDep rather than a prod dep (see the
  // CLAUDE.md gotcha about the embedded fallback loading from the unpacked
  // service-bundle) — but tsup only auto-externalizes prod deps, so the
  // dev-mode `import('@bendyline/gezel-service')` fallback in supervisor's
  // startEmbeddedRaw would otherwise pull the entire service tree
  // (including native .node addons) into the bundled main.js. Explicit
  // external keeps it as a runtime dynamic import.
  external: ['electron', '@bendyline/gezel-service'],
  onSuccess: async () => {
    // A final guard on the emitted bytes. This is intentionally about the
    // bundle rather than the source/config: it catches a future tsup upgrade
    // or config refactor that starts externalizing either workspace package
    // again before electron-builder can create a broken installer.
    const mainBundle = readFileSync('dist/main.js', 'utf8');
    for (const packageName of ['@bendyline/gezel', '@bendyline/gezel-client']) {
      const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const bareImport = new RegExp(
        String.raw`(?:from\s*|import\s*\()\s*["']${escaped}(?:/[^"']*)?["']`,
      );
      if (bareImport.test(mainBundle)) {
        throw new Error(
          `[tsup] dist/main.js still contains a runtime import of ${packageName}; the packaged app would fail because workspace packages are not copied into app.asar`,
        );
      }
    }

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
    // `@bendyline/gezel-ui` is a devDependency ON PURPOSE, even though the UI
    // ships. This copy is a filesystem read of the sibling package's build
    // output — nothing here (or in src/) ever imports the package, so nothing
    // needs it resolvable at runtime. As a production dependency it dragged
    // its whole transitive tree (monaco, mermaid, ffmpeg, pdfjs, squisq —
    // 20k files, ~490 MB) into app.asar of every installer, alongside the
    // 31 MB built bundle that is what actually loads. Keep it a devDependency.
    const uiSrc = resolve(__dirname, '..', 'ui', 'dist');
    if (existsSync(uiSrc)) {
      cpSync(uiSrc, 'dist/ui', { recursive: true });
    } else {
      console.warn(
        `[tsup] no UI bundle at ${uiSrc} — did you run \`pnpm --filter @bendyline/gezel-ui build\`? The packaged app will show the no-UI placeholder.`,
      );
    }

    // Download + verify the pinned ordinary pnpm package into dist/pnpm-bundle/.
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

    // The DuckDB CLI, into dist/duckdb-bundle/. Vendored unmodified from the
    // DuckDB Foundation's signed + notarized release rather than built by our
    // native pipeline, which is why it sits here beside node and pnpm instead
    // of in native-bin/. The supervisor's extract-duckdb step installs it to
    // `~/.gezel/engines/duckdb/<version>/` — the same directory the service's
    // engine resolver downloads into for npm / CLI installs.
    const duckdbRes = spawnSync(process.execPath, ['scripts/fetch-duckdb.mjs'], {
      stdio: 'inherit',
    });
    if (duckdbRes.status !== 0) {
      if (process.env.GEZEL_DUCKDB_SKIP === '1') {
        console.warn('[tsup] fetch-duckdb skipped (GEZEL_DUCKDB_SKIP=1)');
      } else {
        throw new Error('[tsup] fetch-duckdb failed — see output above');
      }
    }
  },
});
