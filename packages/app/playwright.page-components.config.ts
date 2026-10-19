import { defineConfig } from '@playwright/test';
import scaffoldConfig from './playwright.scaffold.config.js';

export default defineConfig({ ...scaffoldConfig, testMatch: '**/page-components.spec.ts' });
