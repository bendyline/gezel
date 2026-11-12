import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';
import { projectPageTypographyPlugin } from '../../scripts/project-page-typography.mjs';
import { harperWasmPlugin } from '../ui/scripts/vite-harper-wasm.js';
import { reactWithCompiler } from '../ui/scripts/vite-react.js';
import { browserTypeScriptPlugin } from './scripts/browser-typescript.js';
import { kokoroLexiconPlugin } from './scripts/kokoro-lexicon.js';
import { portableContentPlugin } from './scripts/portable-content.js';
import { portableScriptsPlugin } from './scripts/portable-scripts.js';
import { preloadUiGraphPlugin } from './scripts/preload-ui-graph.js';

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

function mobileBoundary() {
  return {
    name: 'mobile-runtime-boundary',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (source.startsWith('node:') || builtins.has(source)) {
        throw new Error(
          `Mobile code cannot import a Node module: ${source} (from ${importer ?? 'entry'})`,
        );
      }
      if (/^@bendyline\/gezel-(service|mcp|app)(?:\/|$)/.test(source)) {
        throw new Error(`Mobile code cannot import a desktop host: ${source}`);
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [
    mobileBoundary(),
    projectPageTypographyPlugin(fileURLToPath(new URL('../ui', import.meta.url))),
    {
      name: 'native-preview-isolation',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'preview-isolation.js',
          source: readFileSync(new URL('./public/preview-isolation.js', import.meta.url), 'utf8'),
        });
      },
    },
    browserTypeScriptPlugin(),
    kokoroLexiconPlugin(),
    portableScriptsPlugin(),
    portableContentPlugin(),
    // The same React Compiler setup as the desktop UI, for the shared components.
    ...reactWithCompiler(fileURLToPath(new URL('.', import.meta.url))),
    harperWasmPlugin(fileURLToPath(new URL('../ui', import.meta.url))),
    preloadUiGraphPlugin(),
  ],
  base: './',
  resolve: { dedupe: ['react', 'react-dom'] },
  publicDir: '../ui/public',
  optimizeDeps: { exclude: ['@bendyline/squisq-calc', '@ironcalc/wasm'] },
  server: {
    watch: {
      // Native sources/reports and synced web bundles require their own rebuild;
      // changes there must not reload the live product or its browser contracts.
      ignored: ['android', 'ios', 'dist'].map(
        (folder) => `${normalizePath(fileURLToPath(new URL(folder, import.meta.url)))}/**`,
      ),
    },
  },
  worker: {
    format: 'es',
    plugins: () => [mobileBoundary(), browserTypeScriptPlugin(), portableScriptsPlugin()],
  },
  build: { target: 'es2022' },
});
