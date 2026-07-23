/**
 * Dialogs — the create-entity modals. Opened via the app's create events, shot,
 * then dismissed with Escape so nothing is actually created (no state mutation,
 * order-independent).
 */
import { type Page, expect, test } from './fixtures/test.js';
import { settle } from './helpers/determinism.js';
import { gotoHome, openAreaView } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

async function fireDialog(page: Page, event: string) {
  await page.evaluate((e) => window.dispatchEvent(new CustomEvent(e)), event);
  const dialog = page.locator('[role=dialog]').first();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await settle(page);
  return dialog;
}

test.describe('dialogs', () => {
  test('create-gezel dialog', async ({ page }) => {
    await gotoHome(page);
    await openAreaView(page, 'gezels');
    const dialog = await fireDialog(page, 'gezel:new-gezel');
    await shot(page, 'create-gezel', {
      area: 'dialogs',
      clip: dialog,
      selector: '[role=dialog]',
      description: 'Create-gezel dialog — scratch / template tabs',
    });
    await page.keyboard.press('Escape');
  });

  test('create-project dialog', async ({ page }) => {
    await gotoHome(page);
    await openAreaView(page, 'projects');
    const dialog = await fireDialog(page, 'gezel:new-project');
    await shot(page, 'create-project', {
      area: 'dialogs',
      clip: dialog,
      selector: '[role=dialog]',
      description: 'Create-project dialog — name, about, mission',
    });
    await page.keyboard.press('Escape');
  });
});
