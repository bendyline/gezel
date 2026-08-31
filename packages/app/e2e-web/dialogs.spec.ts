/**
 * Dialogs — the create-entity modals. Opened through their visible area controls,
 * shot, then dismissed with Escape so nothing is actually created (no state
 * mutation, order-independent).
 */
import { type Page, expect, test } from './fixtures/test.js';
import { settle } from './helpers/determinism.js';
import { gotoHome, openAreaView } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

async function openDialog(page: Page, triggerName: string, dialogName: string) {
  await page.getByRole('button', { name: triggerName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await settle(page);
  return dialog;
}

test.describe('dialogs', () => {
  test('create-gezel dialog', async ({ page }) => {
    await gotoHome(page);
    await openAreaView(page, 'gezels');
    const dialog = await openDialog(page, '+ New Gezel', 'New Gezel');
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
    const dialog = await openDialog(page, '+ New Project', 'New Project');
    await shot(page, 'create-project', {
      area: 'dialogs',
      clip: dialog,
      selector: '[role=dialog]',
      description: 'Create-project dialog — name, about, mission',
    });
    await page.keyboard.press('Escape');
  });
});
