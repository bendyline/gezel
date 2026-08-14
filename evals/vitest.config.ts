import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// Vitest otherwise scales its fork pool to nearly every available core. This
// suite includes CPU-heavy calibration cases and tests that launch nested
// Vitest, TypeScript, and Node processes, so an unbounded pool can exhaust a
// host during a recursive workspace test run and make an otherwise-green fork
// disappear during teardown (`[vitest-pool]: Worker forks emitted error`).
const MAX_WORKERS = Math.max(1, Math.min(8, availableParallelism()));

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
    maxWorkers: MAX_WORKERS,
  },
});
