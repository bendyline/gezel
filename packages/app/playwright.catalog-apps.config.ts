import { defineConfig } from '@playwright/test';
import scaffoldConfig from './playwright.scaffold.config.js';

/** GILDE_DIR + GEZEL_GILDE_DATA_DIR select the catalog checkout under review. */
export default defineConfig({
  ...scaffoldConfig,
  testMatch: ['**/catalog-app-pages.spec.ts', '**/catalog-app-host.spec.ts'],
  workers: 2,
});
