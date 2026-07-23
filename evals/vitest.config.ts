import { defineConfig } from 'vitest/config';

/**
 * Without an explicit `exclude`, vitest discovers any `*.test.ts` file
 * under the package, including files that landed inside `evals/runs/`
 * when a scenario like `squisq-review` cloned an external repo with
 * its own test suite. Those tests aren't ours to run; their presence
 * would block `pnpm test` immediately after any trial that touches a
 * repo with vitest specs of its own.
 *
 * The defaults `node_modules/**`, `dist/**` etc. carry over from the
 * `defaultExclude` baseline — just adding `runs/**` to keep eval-run
 * output trees out of the test discovery surface.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'runs/**'],
  },
});
