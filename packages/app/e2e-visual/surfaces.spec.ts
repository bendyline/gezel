import { expect, test } from '../e2e-web/fixtures/test.js';
import { setTheme } from '../e2e-web/helpers/determinism.js';
import { expectHandboekArticle } from '../e2e-web/helpers/handboek.js';
import { gotoHome, openAreaView } from '../e2e-web/helpers/nav.js';
import { shot } from '../e2e-web/helpers/shot.js';

test('Handboek renders its article in both themes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('sidebar-area-knowledge')).toBeAttached();
  await openAreaView(page, 'knowledge');
  await expectHandboekArticle(page);
  const view = page.getByTestId('knowledge-view');
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await test.info().attach(`handboek-knowledge-${theme}`, {
      body: await view.screenshot(),
      contentType: 'image/png',
    });
  }
  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 650) {
    await view.getByRole('button', { name: '← Documents' }).click();
    await expect(view.getByRole('region', { name: 'Documents' })).toBeVisible();
    await view.getByRole('button', { name: '← Topics' }).click();
    await expect(
      view.getByRole('navigation', { name: 'Knowledge catalogs and topics' }),
    ).toBeVisible();
    await view.getByRole('button', { name: 'All documents' }).click();
    await expect(view.getByRole('region', { name: 'Documents' })).toBeVisible();
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
