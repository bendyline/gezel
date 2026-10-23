import { defineConfig } from '@playwright/test';
import webConfig from './playwright.web.config.js';

/** The generated app uses source contracts and needs no compiled shell or screenshot gallery. */
export default defineConfig({
  ...webConfig,
  testMatch: '**/app-scaffold.spec.ts',
  globalSetup: undefined,
  globalTeardown: undefined,
  projects: [{ name: 'desktop' }],
});
