import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    env: {
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_NATIVE_CAPACITY_AUTHORITY: 'local',
      GEZEL_LOG_LEVEL: 'error',
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
