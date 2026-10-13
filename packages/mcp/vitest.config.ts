import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// Several files import the complete tool server into isolated workers. Starting
// one worker per CPU makes their cold transforms contend and can exhaust a
// registration test's normal budget before it reaches an assertion.
const MAX_WORKERS = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));

export default defineConfig({
  test: {
    maxWorkers: MAX_WORKERS,
  },
});
