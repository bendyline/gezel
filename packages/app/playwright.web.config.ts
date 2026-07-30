import { defineConfig } from '@playwright/test';
import { VIEWPORTS } from './e2e-web/helpers/determinism.js';

/**
 * Browser (HTTP) UX suite — drives the React UI served by an in-process gezel
 * daemon in web mode, and writes a predictable screenshot gallery to
 * ux-screenshots/. Separate from playwright.config.ts (the Electron suite):
 * unlike Electron launches, browser contexts + per-worker ephemeral-port
 * daemons isolate cleanly, so this suite parallelizes.
 */
export default defineConfig({
  testDir: './e2e-web',
  globalSetup: './e2e-web/fixtures/global-setup.ts',
  globalTeardown: './e2e-web/fixtures/global-teardown.ts',
  // Boot + seed happen in the worker fixture and are charged to the first test;
  // give real headroom for a cold first boot.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  // A smoke failure must fail the quality gate on its first occurrence.
  // The fixtures retain diagnostics and traces for postmortem inspection.
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    // Overridden per-worker by the daemon fixture; a valid placeholder so
    // relative page.goto('/') type-checks before the override resolves.
    baseURL: 'http://127.0.0.1:6228',
    browserName: 'chromium',
    reducedMotion: 'reduce',
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    viewport: VIEWPORTS.default,
    deviceScaleFactor: 2,
    trace: 'retain-on-failure',
    // Built-in failure screenshots go to test-results/, separate from the gallery.
    screenshot: 'only-on-failure',
    launchOptions: {
      // Cross-machine pixel stability.
      args: ['--force-color-profile=srgb', '--font-render-hinting=none'],
    },
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: [/compact\.spec\.ts/],
      use: { viewport: VIEWPORTS.default, deviceScaleFactor: 2 },
    },
    {
      // Narrow viewport only runs the compact-layout spec(s).
      name: 'narrow',
      testMatch: [/compact\.spec\.ts/],
      use: { viewport: VIEWPORTS.narrow, deviceScaleFactor: 2 },
    },
  ],
});
