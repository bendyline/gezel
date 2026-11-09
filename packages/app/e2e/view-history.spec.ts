import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));

async function launch(gezelHome: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(_dirname, '..')],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_EMBEDDED: '1',
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    }),
  });
}

test.setTimeout(120_000);

async function openTab(page: Page, detail: Record<string, unknown>): Promise<void> {
  await page.evaluate((d) => {
    window.dispatchEvent(new CustomEvent('gezel:open-tab', { detail: d }));
  }, detail);
}

function activeSettingsSection(page: Page) {
  return page.locator('.settings-nav .settings-nav-item-active');
}

test('Back, Forward and the trail of views visited', async () => {
  const gezelHome = await mkdtemp(join(tmpdir(), 'gezel-view-history-e2e-'));
  const app = await launch(gezelHome);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible({ timeout: 60_000 });

    const back = page.getByTestId('history-back');
    const forward = page.getByTestId('history-forward');
    const projectView = page.locator('.project-view.detail-only');

    await test.step('a fresh window has nowhere to go', async () => {
      await expect(page.getByRole('toolbar', { name: 'Back and forward' })).toBeVisible();
      // The app may reopen a stored view; start the trail from Home.
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('gezel:navigate', { detail: { view: 'home' } }));
      });
    });

    await test.step('visit Settings, one of its sections, then a project', async () => {
      await openTab(page, { kind: 'area', area: 'settings' });
      await expect(activeSettingsSection(page)).toBeVisible({ timeout: 15_000 });
      await page.locator('.settings-nav .settings-nav-item', { hasText: /^Folders$/ }).click();
      await expect(activeSettingsSection(page)).toHaveText('Folders');
      await openTab(page, { kind: 'project', id: 'default' });
      await expect(projectView).toBeVisible({ timeout: 15_000 });
      await expect(back).toHaveAccessibleName('Back to Settings · Folders');
      await expect(forward).toBeDisabled();
    });

    await test.step('Back reopens each view where it was left', async () => {
      await back.click();
      await expect(activeSettingsSection(page)).toHaveText('Folders', { timeout: 15_000 });
      await back.click();
      await expect(activeSettingsSection(page)).toHaveText('General');
      await expect(forward).toHaveAccessibleName('Forward to Settings · Folders');
    });

    await test.step('the trail jumps straight to a view', async () => {
      await page.getByTestId('history-trail').click();
      const menu = page.getByRole('menu', { name: 'Views you have visited' });
      await expect(menu).toBeVisible();
      const items = menu.getByRole('menuitem');
      await expect(items.nth(2)).toHaveAttribute('aria-current', 'page');
      await items.first().click();
      await expect(projectView).toBeVisible({ timeout: 15_000 });
      await expect(forward).toBeDisabled();
    });

    await test.step('the keyboard steps back and forward outside a field', async () => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const mac = process.platform === 'darwin';
      await page.keyboard.press(mac ? 'Meta+BracketLeft' : 'Alt+ArrowLeft');
      await expect(activeSettingsSection(page)).toHaveText('Folders', { timeout: 15_000 });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press(mac ? 'Meta+BracketRight' : 'Alt+ArrowRight');
      await expect(projectView).toBeVisible({ timeout: 15_000 });
    });

    await test.step('the trail survives a reload', async () => {
      await page.reload();
      await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('history-back')).toHaveAccessibleName(
        'Back to Settings · Folders',
        { timeout: 15_000 },
      );
    });
  } finally {
    await closeApp(app);
    await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
  }
});
