import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the unit-test side of the extension package.
 *
 * The `e2e/` tree and its compiled `dist-e2e/` output drive a real VS
 * Code instance through `@vscode/test-electron` (see `tsup.e2e.config.ts`
 * and `e2e/runTests.ts`). Those files `import 'vscode'`, which only
 * resolves inside an extension host — when vitest tries to load them as
 * regular Node modules they fail with `Cannot find module 'vscode'`.
 *
 * Default vitest globs (`**\/*.test.ts`) would otherwise pick them up.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-e2e/**', '**/e2e/**'],
  },
});
