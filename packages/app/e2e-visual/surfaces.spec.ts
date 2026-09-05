import { expect, test } from '../e2e-web/fixtures/test.js';
import { setTheme } from '../e2e-web/helpers/determinism.js';
import { expectHandboekArticle } from '../e2e-web/helpers/handboek.js';
import { gotoHome, openArea } from '../e2e-web/helpers/nav.js';
import { shot } from '../e2e-web/helpers/shot.js';

test('Handboek renders its article in both themes', async ({ page }) => {
  await gotoHome(page);
  if (page.viewportSize()!.width < 700) {
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  }
  await openArea(page, 'handboek');
  await expectHandboekArticle(page);
  const view = page.getByTestId('handboek-view');
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await shot(page, 'home', {
      area: 'handboek',
      theme,
      clip: view,
      description: 'Handboek with loaded navigation, welcome prose, and illustration',
    });
  }
});

test('composer supports a typed draft in both themes', async ({ page }) => {
  await gotoHome(page);
  if (page.viewportSize()!.width < 700) {
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  }
  const chat = page.getByTestId('meester-chat');
  await expect(chat.locator('.msg-assistant').first()).toContainText('Mock reply');
  const composer = chat.getByTestId('chat-composer');
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  const editor = composer.locator('.squisq-wysiwyg-editor').first();
  await editor.fill('Draft a launch plan for the landing page');
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await shot(page, 'composer-typed', {
      area: 'chat',
      theme,
      clip: composer,
      description: 'Typed draft with recipient, session picker, editor, and send controls',
    });
  }
});

test('project creation shows its starting points and configuration', async ({ page }) => {
  await gotoHome(page);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Project', exact: true });
  await expect(dialog.getByRole('radio', { name: 'General', exact: true })).toBeVisible();
  const gallery = await dialog.getByRole('radiogroup', { name: 'Project type' }).boundingBox();
  const footer = await dialog.locator('.gz-npd-pick-footer').boundingBox();
  expect(gallery).not.toBeNull();
  expect(footer).not.toBeNull();
  expect(Math.abs(gallery!.y + gallery!.height - footer!.y)).toBeLessThanOrEqual(1);
  await shot(page, 'create-project', {
    area: 'dialogs',
    clip: dialog,
    description: 'New Project starting-point gallery',
  });
  await dialog.getByRole('radio', { name: 'General', exact: true }).click();
  const configured = page.getByRole('dialog', { name: 'General', exact: true });
  await expect(configured.locator('.gz-npd-brief')).toBeVisible();
  await shot(page, 'create-project-configure', {
    area: 'dialogs',
    clip: configured,
    description: 'General project configuration form and ingredients',
  });
});
