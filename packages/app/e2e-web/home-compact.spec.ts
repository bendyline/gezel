import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/test.js';

test.use({ daemonGroup: 'home-compact', viewport: { width: 390, height: 844 }, hasTouch: true });

async function expectDraftInsideApp(page: Page) {
  const editor = page.locator('.home-workshop .chat-composer [contenteditable="true"]');
  await expect(editor).toBeVisible();
  await expect
    .poll(() =>
      editor.evaluate((node) => {
        const draft = node.getBoundingClientRect();
        const app = document.querySelector('.app')!.getBoundingClientRect();
        return Math.max(app.top - draft.top, draft.bottom - app.bottom);
      }),
    )
    .toBeLessThanOrEqual(1);
}

test('Home keeps the draft reachable beside starters and folder setup', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Home ·/ }).click();
  await expect(page.getByTestId('home-workshop')).toBeVisible();
  // Use the native host's actual safe-area and keyboard rules around the shared UI.
  await page.addStyleTag({
    path: fileURLToPath(new URL('../../mobile/src/product-host.css', import.meta.url)),
  });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-area-inset-top', '59px');
    document.documentElement.style.setProperty('--safe-area-inset-bottom', '34px');
  });
  await expect(page.locator('.home-make-card').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skip for now' })).toBeVisible();
  await expectDraftInsideApp(page);

  // A keyboard shrinks WebKit's visual viewport without resizing its layout viewport.
  await page.evaluate(() => {
    document.documentElement.dataset.keyboard = 'open';
    document.documentElement.style.setProperty('--app-viewport-height', '400px');
  });
  await expectDraftInsideApp(page);
  await page.evaluate(() => {
    delete document.documentElement.dataset.keyboard;
    document.documentElement.style.removeProperty('--app-viewport-height');
  });

  // Folder setup must remain usable through its own scroll area.
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.locator('.folder-onboarding')).toHaveCount(0);
  await expectDraftInsideApp(page);

  await page.setViewportSize({ width: 844, height: 390 });
  await expectDraftInsideApp(page);
});
