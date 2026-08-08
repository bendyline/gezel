import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from 'tsup';

const repoRoot = path.resolve(__dirname, '..', '..');
const embeddedSrc = path.join(repoRoot, 'packages', 'ui', 'dist-embedded');
const embeddedDst = path.resolve(__dirname, 'dist', 'webview', 'embedded');

/**
 * Copy the gezel chat bundle the UI package produces in `dist-embedded/`
 * into the extension's `dist/webview/embedded/`. The chat-view loads
 * `chat.global.js` + `chat.css` (plus the fonts under `assets/`) from
 * that path via `asWebviewUri`. Build order: `packages/ui` must finish
 * `vite build --config vite.embedded.config.ts` before this runs. The root
 * `build:packages` script invokes the UI's `build:all` target before it builds
 * this package; the workspace dependency alone does not select that target.
 */
function copyEmbeddedChatAssets(): void {
  if (!fs.existsSync(embeddedSrc)) {
    const message = `[gezel-vscode] embedded chat bundle missing at ${embeddedSrc} - run \`pnpm --filter @bendyline/gezel-ui build:embedded\` first.`;
    // Watch mode may start before the UI's first embedded build completes;
    // keep that development loop available. A production build must fail
    // instead of publishing an extension whose chat webview only 404s.
    if (process.argv.includes('--watch') || process.argv.includes('-w')) {
      console.warn(message);
      return;
    }
    throw new Error(message);
  }
  fs.rmSync(embeddedDst, { recursive: true, force: true });
  fs.mkdirSync(embeddedDst, { recursive: true });
  copyRecursive(embeddedSrc, embeddedDst);
}

function copyRecursive(src: string, dst: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

export default defineConfig([
  {
    entry: { extension: 'src/extension.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    target: 'node18',
    platform: 'node',
    external: ['vscode'],
    // Workspace packages are ESM-only with no `require` condition on
    // their `./node` subpath. Bundling them in keeps the CJS extension
    // self-contained and side-steps the dual-package-hazard at load
    // time. Third-party deps (undici, zod, etc.) stay external — they
    // ship correct CJS entries and the .vscodeignore preserves
    // node_modules.
    noExternal: [/^@bendyline\//],
    dts: false,
    sourcemap: true,
    clean: true,
    splitting: false,
    shims: false,
  },
  {
    entry: { 'webview-bridge': 'webview/bridge.ts' },
    format: ['iife'],
    target: 'es2022',
    platform: 'browser',
    dts: false,
    sourcemap: false,
    splitting: false,
    minify: true,
    outDir: 'dist/webview',
    globalName: 'GezelWebviewBridge',
    async onSuccess() {
      copyEmbeddedChatAssets();
    },
  },
]);
