import { defineConfig } from '@playwright/test';
import webConfig from './playwright.web.config.js';

// Baselines use the macOS 26 ARM Chromium renderer, also selected in CI.
// Other platforms can run behavioral tests with playwright.web.config.ts.
export default defineConfig({
  ...webConfig,
  testDir: './e2e-visual',
  metadata: { visualRegression: true },
  outputDir: './visual-test-results',
  snapshotPathTemplate: '{testDir}/snapshots/{platform}-{projectName}/{arg}{ext}',
  updateSnapshots: 'none',
  forbidOnly: !!process.env.CI,
  reporter: [['line'], ['html', { outputFolder: 'visual-report', open: 'never' }]],
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      animations: 'disabled',
      scale: 'css',
      // A small absolute allowance cannot swallow a missing component on a large frame.
      maxDiffPixels: 100,
      threshold: 0.2,
    },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { viewport: { width: 820, height: 900 }, hasTouch: true } },
    {
      name: 'phone',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
