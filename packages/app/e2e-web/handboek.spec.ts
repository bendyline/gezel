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
  const article = {
    title: 'Local-first: your data stays on your disk',
    body: 'your work belongs to you, on your machine, in files you can read.',
  };
  await page.getByRole('button', { name: 'Concepts', exact: false }).click();
  await page.getByRole('button', { name: article.title, exact: false }).click();
  await expectHandboekArticle(page, article);
  await expect(page.locator('.knowledge-reader-body')).not.toContainText(
    'is Dutch for a companion journeyman.',
  );
});

test('Handboek article links open catalog documents', async ({ page }) => {
  await gotoHome(page);
  await openArea(page, 'knowledge');
  await expectHandboekArticle(page);
  await page.locator('.knowledge-reader-body').getByRole('link', { name: 'Your crew' }).click();
  await expectHandboekArticle(page, {
    title: 'Your crew: gezellen, the Meester, and the Voorman',
    body: 'is a named AI companion with a role.',
  });
});
