import { expect, test } from './fixtures/test.js';
import { gotoHome } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

test.use({ daemonGroup: 'starter-launch' });

test('Home starts a research report from Make something with a topic', async ({ page }) => {
  await gotoHome(page);
  await page.getByRole('tab', { name: 'Make something', exact: true }).click();
  const tray = page.getByRole('region', { name: 'Make something' });
  await expect(tray).toBeVisible();
  await tray.getByRole('button', { name: /Research report/ }).click();
  const dialog = page.locator('.gz-ntd-quick');
  const brief = dialog.getByRole('textbox', { name: /Topic|What should this be about/ });
  await expect(brief).toBeFocused();
  await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).not.toBeVisible();
  await expect(dialog.locator('details')).not.toHaveAttribute('open', '');
  await brief.fill('Compare ways to grow herbs on a balcony');
  await shot(page, 'research-quick-launch', {
    area: 'home',
    description: 'Home plan launch — topic, output preview, Start now and Tonight',
  });
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/projects\/[^/]+\/tasks$/.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole('button', { name: 'Start now' }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const request = response.request().postDataJSON();
  expect(request).toMatchObject({
    craftbookId: 'research-report',
    title: 'Compare ways to grow herbs on a balcony',
    dispatchEntry: true,
  });
  expect(request).not.toHaveProperty('assignee');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId('task-detail')).toBeVisible();
});
