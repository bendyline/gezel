import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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
  test: {
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
