import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * `gezel://` links, end to end (docs/deep-links.md): a link on the first-launch
 * command line (the Windows and Linux path) waits through the splash and opens
 * New Project on that app's form; later links through macOS `open-url` open a
 * craftbook's launch form and a Handboek article. GEZEL_E2E keeps the run from
 * registering the scheme, so nothing here touches the machine's handler.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { waitForAppReady } from './helpers/app-ready.js';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));

let app: ElectronApplication;
let page: Page;
let gezelHome: string;

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-e2e-deep-links-'));
  app = await electron.launch({
    args: [join(_dirname, '..'), 'gezel://app/meal-planner'],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_EMBEDDED: '1',
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    }),
  });
  page = await app.firstWindow();
  await waitForAppReady(page);
});

test.afterAll(async () => {
  await closeApp(app);
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

async function openUrl(url: string): Promise<void> {
  await app.evaluate(({ app: electronApp }, link) => {
    electronApp.emit('open-url', { preventDefault() {} }, link);
  }, url);
}

test('a link on the launch command line opens New Project on that app', async () => {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText('Meal Planner', { timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('an open-url link opens a craftbook launch form without starting it', async () => {
  await openUrl('gezel://craftbook/fact-check');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText(/fact/i);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('a docs link opens the Handboek article in Knowledge', async () => {
  await openUrl('gezel://docs/model-scorecard');
  const view = page.getByTestId('knowledge-view');
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect(view.locator('.knowledge-reader-header h2')).toContainText(/scorecard/i, {
    timeout: 30_000,
  });
});
