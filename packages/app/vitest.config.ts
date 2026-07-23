import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright's e2e suites use Playwright's `test.beforeAll` etc., which
    // look like Vitest calls but aren't. Keep them isolated — `pnpm test:e2e`
    // (Electron) and `pnpm test:e2e:web` (browser) drive those via Playwright's
    // own runner.
    exclude: ['node_modules', 'dist', 'e2e/**', 'e2e-web/**'],
  },
});
