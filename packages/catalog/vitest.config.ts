import { defineConfig } from 'vitest/config';

// Most suites here sweep the whole pinned gilde tree (~35k files). On a slower
// machine running every package at once they take 10s+, past Vitest's 5s default.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
