import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Second Vite build target — produces the chat-only IIFE bundle the
 * VS Code extension's webview loads in place of the daemon iframe.
 *
 * The SPA build at `vite.config.ts` is the primary target (served by
 * the daemon, packaged into the Electron app). This config is purely
 * additive: same source tree, different entry point and rollup shape.
 *
 *   pnpm --filter @bendyline/gezel-ui build:embedded
 *
 * Output layout (consumed by packages/vscode/tsup post-build copy):
 *   dist-embedded/chat.global.js   — IIFE bundle (React, Radix, all
 *                                    `@bendyline/*`, and the chat tree)
 *   dist-embedded/chat.css         — single stylesheet (styles.css +
 *                                    fonts.css + embedded.css combined)
 *   dist-embedded/assets/*.woff2   — bundled web fonts, referenced by
 *                                    chat.css with relative `assets/`
 *                                    URLs that resolve under the
 *                                    extension's webview localResourceRoots
 *
 * Why NOT `build.lib`:
 *   - Vite's library mode ignores `assetsInlineLimit` and inlines every
 *     referenced asset (including ~15 WOFF2 fonts) as base64 data URIs
 *     directly in the CSS, producing a ~7MB chat.css. The webview
 *     re-downloads the whole stylesheet on every collapse/expand.
 *   - We instead use a regular Vite build with `rollupOptions` shaped
 *     for IIFE output. This keeps Vite's normal asset pipeline — fonts
 *     emit as separate files referenced by relative URL.
 */
export default defineConfig({
  // The bundle is hosted below VS Code's opaque webview origin at
  // `dist/webview/embedded/`, not at the origin root. Keep every emitted
  // font, icon-font, and worker URL relative to chat.css/chat.global.js so
  // it resolves through the extension's localResourceRoots.
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-embedded',
    emptyOutDir: true,
    sourcemap: true,
    cssCodeSplit: false,
    target: 'esnext',
    // This target is deliberately one self-contained IIFE. Vite has already
    // expanded its compile-time import.meta features before Rolldown reaches
    // this replacement; runtime module metadata does not exist in a webview
    // IIFE, so make the default `{}` behavior explicit and quiet.
    chunkSizeWarningLimit: 17_000,
    // Force EVERY asset external — large WOFF2s would inline by default
    // and bloat chat.css. Setting 0 makes the threshold un-meetable
    // for any non-empty asset.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: 'src/embedded/webview-main.tsx',
      transform: { define: { 'import.meta': '{}' } },
      output: {
        format: 'iife',
        name: 'GezelChatEmbed',
        entryFileNames: 'chat.global.js',
        assetFileNames: (info) => {
          if (info.name?.endsWith('.css')) return 'chat.css';
          // Fonts and any other static assets land at
          // `assets/<original-name>`. No hash — the webview HTML
          // hard-codes the URI through `asWebviewUri` and we want
          // stable names for the copy step.
          return 'assets/[name][extname]';
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
