import { defineConfig } from 'tsup';

/**
 * Separate tsup config for the e2e test harness.
 *
 * The extension-under-test is bundled by the main `tsup.config.ts` to
 * `dist/extension.cjs`. This config bundles the OUTER test runner
 * (`runTests.ts`) plus the INNER Mocha bootstrap (`suite/index.ts`)
 * plus each test file into `dist-e2e/` as CommonJS — VS Code's
 * extension test host loads them via `require()` and chokes on ESM.
 *
 * Each `*.test.ts` is its own entry so Mocha's glob can pick them up
 * after the bundler runs.
 */
export default defineConfig({
  entry: [
    'e2e/runTests.ts',
    'e2e/suite/index.ts',
    'e2e/suite/activation.test.ts',
    'e2e/suite/lm-provider.test.ts',
  ],
  format: ['cjs'],
  outDir: 'dist-e2e',
  outExtension: () => ({ js: '.cjs' }),
  target: 'node18',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  // The test runner imports `mocha` and `glob` and the VS Code
  // extension host imports `vscode`. These all live in node_modules at
  // runtime — don't bundle them.
  external: ['vscode', 'mocha', 'glob', '@vscode/test-electron'],
});
