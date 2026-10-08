import { expect, test } from './fixtures/test.js';
import { expectHandboekArticle } from './helpers/handboek.js';
import { gotoHome, openArea } from './helpers/nav.js';

test('Handboek readiness waits for article content after the view has mounted', async ({
  page,
}) => {
  await gotoHome(page);
  let releaseArticle!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseArticle = resolve;
  });
  let articleRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    articleRequested = resolve;
  });
  await page.route('**/api/knowledge/catalogs/handboek/document?id=welcome', async (route) => {
    articleRequested();
    await held;
    await route.continue();
  });
  let ready = false;
  let readiness: Promise<void> | undefined;
  try {
    await openArea(page, 'knowledge');
    readiness = expectHandboekArticle(page).then(() => {
      ready = true;
    });
    const view = page.getByTestId('knowledge-view');
    await requested;
    await expect(view.getByRole('region', { name: 'Article' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(view.getByText('Loading…', { exact: true })).toHaveCount(0);
    await expect(view.locator('.knowledge-reader-body')).toHaveCount(0);
    expect(ready).toBe(false);
  } finally {
    releaseArticle();
    await readiness;
  }
  expect(ready).toBe(true);
});

test('Handboek navigation loads the newly selected article', async ({ page }) => {
  await gotoHome(page);
  await openArea(page, 'knowledge');
  await expectHandboekArticle(page);
  const row = page.locator('.knowledge-doc-row:not([aria-current="true"])').first();
  const article = { title: (await row.locator('.knowledge-doc-title').innerText()).trim() };
  const previousBody = await page.locator('.knowledge-reader-body').innerText();
  await row.click();
  await expectHandboekArticle(page, article);
  await expect(page.locator('.knowledge-reader-body')).not.toHaveText(previousBody);
});

test('Handboek article links open catalog documents', async ({ page }) => {
  await gotoHome(page);
  await openArea(page, 'knowledge');
  await expectHandboekArticle(page);
  const previousBody = await page.locator('.knowledge-reader-body').innerText();
  await page
    .locator('.knowledge-reader-body a[href="knowledge://bendyline/handboek/the-crew"]')
    .click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('gezel:knowledge:document')))
    .toBe('the-crew');
  await expectHandboekArticle(page);
  await expect(page.locator('.knowledge-reader-body')).not.toHaveText(previousBody);
});
