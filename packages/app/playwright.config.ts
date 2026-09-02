import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Wipe the UX-tour screenshot folder once per run (not per worker — a
  // failure-triggered worker restart must not delete captured shots).
  globalSetup: './e2e/helpers/clean-ux-tour-shots.ts',
  timeout: 30000,
  // Parallel workers can't share Electron launches reliably on
  // Windows — multiple processes attaching to the inspector at once
  // race with each other and the WS disconnects on launch with
  // exitCode=0 before the BrowserWindow loads. Single worker is the
  // honest shape: every spec spawns its own Electron app, the home
  // dirs are scoped per-spec, but the launches must be serialized.
  workers: 1,
  // Quality-gate runs must expose the first failure. Individual tests carry
  // lifecycle-appropriate timeouts instead of being made green by retries.
  retries: 0,
  use: {
    trace: 'retain-on-failure',
  },
});
