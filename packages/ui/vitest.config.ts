import react from '@vitejs/plugin-react';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

const workspaceRoot = searchForWorkspaceRoot(import.meta.dirname);

/**
 * Vitest config for the UI package.
 *
 * The suite mixes pure UI logic with components and top-level views that
 * mount real React trees through `@testing-library/react`. jsdom is fast
 * enough that one environment is simpler than maintaining file-by-file
 * environment splits as the suite grows.
 *
 * setupFiles loads `@testing-library/jest-dom`'s matchers and a global
 * mock of `../api.js` so view tests don't accidentally hit fetch.
 */
export default defineConfig({
  plugins: [react()],
  // Mirrors vite.config.ts: with `pnpm link:squisq` active the linked
  // checkout would otherwise load its own react 18, whose context
  // objects react-dom 19 refuses to render (React error #130).
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  // Vitest narrows Vite's file-serving allow-list to this package. On Linux,
  // pnpm resolves `@ironcalc/wasm/...wasm?url` through the workspace-level
  // virtual store, so Vite rejects the asset before vi.mock can intercept it.
  // Keep test transforms inside this workspace while permitting dependencies
  // installed by the workspace package manager.
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
  test: {
    // Dedupe only applies to modules vite PROCESSES. Vitest externalizes
    // node_modules by default, and under `pnpm link:squisq` the linked
    // dist chunks then node-resolve `react` from the sibling checkout's
    // own node_modules — a second React that breaks hooks ("Cannot read
    // properties of null (reading 'useRef')" in tiptap's useEditor).
    // Inlining the squisq + tiptap packages routes their imports through
    // vite, where the dedupe above pins every React to this package's.
    server: {
      deps: {
        inline: [/@bendyline[\\/]squisq/, /@tiptap[\\/]/],
      },
    },
    environment: 'jsdom',
    setupFiles: ['./src/test-utils/setup.ts'],
    globals: false,
    css: false,
    // `clearMocks` resets call history between tests so each one starts
    // with empty `mock.calls`. We deliberately do NOT enable `restoreMocks`
    // here — restore puts every vi.fn() back to a no-op (returns undefined),
    // which breaks our Proxy-backed `createMockApi()` because the cached fn
    // is reused across tests and the next test's beforeEach has no chance
    // to re-install defaults before code under test calls e.g. `api.getConfig()`.
    clearMocks: true,
  },
});
