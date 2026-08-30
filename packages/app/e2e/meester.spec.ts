import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Meester E2E — first-launch auto-provisioning. On an empty GEZEL_HOME, the
 * service should create the curated Meester gezel (and a Klerk for utility
 * work), tag the Meester via `config.meesterGezelId`, and the UI should
 * render the ⭐ badge on the sidebar + a populated Settings section.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-meester-e2e-'));
  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
});

test.afterAll(async () => {
  await closeApp(app);
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

async function expandGezels(): Promise<void> {
  // The caret button toggles the inline list; the sibling `sidebar-group-gezels`
  // button navigates to the Gezellen area instead (and carries no aria-expanded).
  const toggle = page.locator('[data-testid="sidebar-group-toggle-gezels"]');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

test('first-run auto-provisions a Meester gezel', async () => {
  await expandGezels();

  // Auto-provisioning happens asynchronously after the service boots.
  // `beforeAll`'s 2500ms wait is usually enough, but a slow first-time
  // gilde-catalog read or a contended CI worker can push it past that.
  // Use Playwright's auto-retrying assertions so we wait for the
  // provisioned state instead of a fixed-timeout snapshot. The
  // provisioned gezels surface in the sidebar's Gezels group.
  const rows = page.locator('.app-sidebar-gezel');
  await expect(rows.first()).toBeVisible({ timeout: 10_000 });

  await page.screenshot({ path: join(screenshotDir, 'meester-01-gezels.png'), fullPage: true });

  // At least one gezel exists (the auto-provisioned Meester; Klerk is
  // also created for utility work, hence not asserting an exact count).
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
});

test('Settings shows the meester with the dropdown pre-selected', async () => {
  await page.locator('[data-testid="sidebar-area-settings"]').click();
  await page.waitForTimeout(500);
  // The meester picker lives in the "Your Team" section — Settings
  // opens on "General" by default, so click into the team section.
  await page.locator('.settings-nav button:has-text("Your Team")').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screenshotDir, 'meester-02-settings.png'), fullPage: true });

  const body = await page.textContent('body');
  expect(body).toContain('Meester');
  expect(body).toContain('concierge');

  // The Radix trigger inside .meester-picker shows the currently-selected
  // gezel's name — expect it to reflect the auto-provisioned Meester.
  // (The Klerk section reuses the same .meester-picker class; the Meester
  // section comes first in the DOM, so .first() targets it.)
  const meesterTrigger = page.locator('.meester-picker .gz-select-trigger').first();
  const triggerText = (await meesterTrigger.textContent()) ?? '';
  expect(triggerText.toLowerCase()).toContain('meester');
});
