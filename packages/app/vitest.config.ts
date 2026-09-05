import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live under src. Keep Playwright's Electron, web, and visual
    // suites with their own runner, including any future e2e directories.
    include: ['src/**/*.test.ts'],
  },
});
