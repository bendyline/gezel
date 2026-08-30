import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Settings → Workloads → Image recognition.
 *
 * Drives the real Electron shell to the new workload panel and captures a
 * screenshot, so the tab is verified where the user actually sees it rather
 * than only in a jsdom component test.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');

test.describe('Image recognition settings', () => {
  let home: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-recognition-'));
    app = await electron.launch({
      args: [appRoot],
      // Mock provider → configured, full shell with sidebar + settings.
      env: buildLaunchEnv({
        GEZEL_HOME: home,
        GEZEL_MOCK_PROVIDER: '1',
        GEZEL_EMBEDDED: '1',
      }),
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
  });

  test.afterAll(async () => {
    await closeApp(app);
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  test('appears under Workloads and renders the policy tray', async () => {
    await page.getByTestId('sidebar-area-settings').click();
    await page.waitForTimeout(800);

    const navItem = page.getByRole('button', { name: 'Image recognition' });
    await expect(navItem).toBeVisible({ timeout: 10000 });
    await navItem.click();
    await page.waitForTimeout(600);

    await expect(page.getByRole('heading', { name: 'Image recognition' })).toBeVisible({
      timeout: 10000,
    });

    // The three policy keys, and "when needed" latched by default.
    const whenNeeded = page.getByRole('radio', { name: /When needed/ });
    await expect(whenNeeded).toBeVisible();
    await expect(whenNeeded).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: /Always/ })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Never/ })).toBeVisible();

    // Both catalog entries, with the default one offered for download.
    await expect(page.getByText('Granite Vision 4.1 (4B)')).toBeVisible();
    await expect(page.getByText('NuExtract 3 (4B)')).toBeVisible();

    await page.screenshot({
      path: join(screenshotDir, 'image-recognition-settings.png'),
      fullPage: true,
    });
  });
});
