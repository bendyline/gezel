import { type Page, expect } from '@playwright/test';

export const WELCOME_ARTICLE = {
  title: 'What is gezel?',
  body: 'is Dutch for a companion journeyman.',
};

/** The bundled catalog, selected article, parsed prose, and inline assets are ready. */
export async function expectHandboekArticle(page: Page, article = WELCOME_ARTICLE): Promise<void> {
  const view = page.getByTestId('knowledge-view');
  await expect(view).toBeVisible();
  await expect(view.locator('.knowledge-catalog-name')).toHaveText('Gezel Handboek');
  await expect(
    view.getByRole('heading', { name: article.title, exact: true }).first(),
  ).toBeVisible();
  const doc = view.locator('.knowledge-reader-body');
  await expect(doc).toBeVisible();
  await expect(doc).toContainText(article.body);
  await expect(view.locator('.error')).toHaveCount(0);
  await expect
    .poll(
      () =>
        doc
          .locator('img')
          .evaluateAll((images) =>
            images.every(
              (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
            ),
          ),
      { message: 'Handboek inline images must load before capture' },
    )
    .toBe(true);
}
