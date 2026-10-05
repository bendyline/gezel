import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Native tests create real disk fixtures. A worker per CPU alongside the other
 * package suites can starve their short test/hook budgets, so leave capacity
 * for those processes instead of scaling this suite to every host core.
 */
const MAX_WORKERS = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

export default defineConfig({
  test: {
    maxWorkers: MAX_WORKERS,
  },
});
