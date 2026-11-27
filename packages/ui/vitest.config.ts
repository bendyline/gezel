import { existsSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { type Plugin, searchForWorkspaceRoot } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import { projectPageTypographyPlugin } from '../../scripts/project-page-typography.mjs';
import { reactWithCompiler } from './scripts/vite-react.js';

const workspaceRoot = searchForWorkspaceRoot(import.meta.dirname);

/**
 * tests/html-preview-host imports the phone's html-preview.ts, which loads the
 * libraries a phone build ships from a module only packages/mobile's Vite
 * config provides. Here it ships none, as in mobile's test-html-preview.mjs.
 */
function emptyPhonePageLibraries(): Plugin {
  const libraries = 'virtual:gezel-page-libraries';
  const lines = 'virtual:gezel-page-library-lines';
  return {
    name: 'empty-phone-page-libraries',
    resolveId: (id) => (id === libraries || id === lines ? `\0${id}` : null),
    load: (id) =>
      id === `\0${libraries}`
        ? 'export default { lines: [], files: {}, modules: {} };'
        : id === `\0${lines}`
          ? 'export default [];'
          : null,
  };
}

/**
 * `.test.ts` files under src that need a DOM. Every other `src/**\/*.test.ts`
 * runs in the `node` project. A DOM test misfiled there fails loudly with
 * `window is not defined` or `document is not defined`: list it here, or make
 * it a `.test.tsx`.
 */
const DOM_TS_TESTS: readonly string[] = [
  'src/components/DocumentExport/export-options.test.ts',
  'src/components/HealthStrip.test.ts',
  'src/components/IndexingReceipt.test.ts',
  'src/components/ProjectOutputPane.test.ts',
  'src/components/SquisqIntegration/document-view.test.ts',
  'src/components/SquisqIntegration/editor-host.test.ts',
  'src/components/SquisqIntegration/proofing.test.ts',
  'src/components/SquisqIntegration/useProofingCapability.test.ts',
  'src/components/WorkspaceIssueFixDialog.test.ts',
  'src/components/chat-bubbles.debug-bundle.test.ts',
  'src/components/chat-bubbles.test.ts',
  'src/components/composer-prefill.test.ts',
  'src/components/document-quick-list.test.ts',
  'src/components/grounding-flags.test.ts',
  'src/components/header-density.test.ts',
  'src/components/horizontal-wheel.test.ts',
  'src/components/indexing-live-sweep.test.ts',
  'src/components/monaco-base.test.ts',
  'src/components/output-pane-maximize.test.ts',
  'src/components/useChatThreadPills.test.ts',
  'src/components/useCompactLayout.test.ts',
  'src/components/useComposerImageSettings.test.ts',
  'src/data/api-reads.test.ts',
  'src/nav-timing.test.ts',
  'src/navigation/KeepAliveHost.test.ts',
  'src/navigation/destinations.test.ts',
  'src/sidebar-side.test.ts',
  'src/startup/screen.test.ts',
  'src/theme.test.ts',
  'src/visible-interval.test.ts',
];

for (const file of DOM_TS_TESTS) {
  if (!existsSync(join(import.meta.dirname, file))) {
    throw new Error(`vitest.config.ts: DOM_TS_TESTS names ${file}, which does not exist`);
  }
}

const NODE_TESTS = globSync('src/**/*.test.ts', { cwd: import.meta.dirname })
  .map((file) => file.replaceAll('\\', '/'))
  .filter((file) => !DOM_TS_TESTS.includes(file));

/**
 * Vitest config for the UI package, as two projects that together run every
 * test file once.
 *
 * - `node`: pure logic (`.test.ts` outside DOM_TS_TESTS), in Node with no
 *   setup file. A jsdom environment and the setup file each cost about a
 *   second per file, which was most of the suite's time for these.
 * - `dom`: components, views and everything else, in jsdom with
 *   `src/test-utils/setup.ts` (jest-dom matchers, per-test cleanup and the
 *   resets of module-level stores). Tests mock `../api.js` themselves.
 *
 * Both projects extend this file, so the plugins (React Compiler included)
 * and the shared test options apply to each.
 */
export default defineConfig({
  // The compiler runs here too, so the suite tests the memoized code that ships.
  plugins: [
    projectPageTypographyPlugin(import.meta.dirname),
    emptyPhonePageLibraries(),
    ...reactWithCompiler(import.meta.dirname),
  ],
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
    // Projects extend this file and Vite concatenates arrays when it merges
    // them, so `include`, `exclude`, `environment` and `setupFiles` are set
    // per project only.
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: NODE_TESTS,
          exclude: [...configDefaults.exclude],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./src/test-utils/setup.ts'],
          // Host integration tests live outside src so native-shell imports
          // do not become production UI TypeScript inputs.
          include: [...configDefaults.include, 'tests/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, ...NODE_TESTS],
        },
      },
    ],
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
    // Every file gets a fresh module graph: module-level stores (drafts,
    // thread memory, the read cache) never leak between files.
    isolate: true,
    // setup.ts lets each waitFor/findBy take 5 s under a contended CI host.
    // A view test chains several of them, so the default 5 s test budget let
    // one slow wait time out the whole test with no message: ScriptsView's
    // project switch took 5009 ms in CI on 2026-11-12, its other tests <150 ms.
    testTimeout: 15_000,
    // Hooks get the same budget. Set here because Vitest forwards only some
    // command-line options to projects: `--testTimeout` reaches them,
    // `--hookTimeout` (which the coverage run passes) does not.
    hookTimeout: 15_000,
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
