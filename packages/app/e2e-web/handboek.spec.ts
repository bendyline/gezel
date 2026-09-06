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
  await page.route('**/api/handboek/article/welcome', async (route) => {
    await held;
    await route.continue();
  });
  let ready = false;
  let readiness: Promise<void> | undefined;
  try {
    await openArea(page, 'handboek');
    readiness = expectHandboekArticle(page).then(() => {
      ready = true;
    });
    const view = page.getByTestId('handboek-view');
    await expect(view.getByText('Loading article…', { exact: true })).toBeVisible();
    await expect(view.getByTestId('handboek-doc')).toHaveCount(0);
    expect(ready).toBe(false);
  } finally {
    releaseArticle();
    await readiness;
  }
  expect(ready).toBe(true);
});

test('Handboek navigation loads the newly selected article', async ({ page }) => {
  await gotoHome(page);
  await openArea(page, 'handboek');
  await expectHandboekArticle(page);
  const article = {
    title: 'Local-first: your data stays on your disk',
    body: 'your work belongs to you, on your machine, in files you can read.',
  };
  await page
    .getByRole('navigation', { name: 'Handboek contents' })
    .getByRole('button', { name: article.title, exact: true })
    .click();
  await expectHandboekArticle(page, article);
  await expect(page.getByTestId('handboek-doc')).not.toContainText(
    'is Dutch for a companion journeyman.',
  );
});
