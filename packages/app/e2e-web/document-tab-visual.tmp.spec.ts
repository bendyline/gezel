import { expect, test } from './fixtures/test.js';
import { gotoHome, openTab } from './helpers/nav.js';

test('selected document joins the canvas', async ({ page, world }) => {
  await gotoHome(page);
  const documentsToggle = page.getByTestId('sidebar-group-toggle-documents');
  if ((await documentsToggle.getAttribute('aria-expanded')) === 'false') {
    await documentsToggle.click();
  }
  const docPath = world?.docPaths?.[0] ?? 'Welcome.md';
  await openTab(page, { kind: 'document', path: docPath });
  await expect(page.locator('.app-sidebar-tree .tree-row-selected')).toBeVisible();
  await page.getByTestId('app-sidebar').screenshot({
    path: 'D:/gh/gezel/packages/app/ux-screenshots/.tmp-document-tab.png',
    animations: 'disabled',
  });
});
