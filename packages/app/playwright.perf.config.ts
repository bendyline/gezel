import { defineConfig } from '@playwright/test';
import { VIEWPORTS } from './e2e-web/helpers/determinism.js';
import webConfig from './playwright.web.config.js';

/**
 * UI responsiveness suite. Reuses the browser suite's in-process daemon and
 * seeded world, grows it to working scale, and writes measurements to
 * test-results/ui-perf.json. One worker, no retries: runs must not compete
 * with each other for the CPU they are measuring.
 */
export default defineConfig({
  testDir: './e2e-perf',
  outputDir: './test-results/perf-artifacts',
  globalSetup: './e2e-perf/global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    ...webConfig.use,
    viewport: VIEWPORTS.default,
    trace: 'off',
    screenshot: 'off',
  },
});
