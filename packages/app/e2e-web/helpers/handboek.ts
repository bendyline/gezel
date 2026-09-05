import { type Page, expect } from '@playwright/test';

export const WELCOME_ARTICLE = {
  title: 'What is gezel?',
  body: 'is Dutch for a companion journeyman.',
};

/** The rail, selected article, parsed prose, and inline assets must all be ready. */
export async function expectHandboekArticle(page: Page, article = WELCOME_ARTICLE): Promise<void> {
  const view = page.getByTestId('handboek-view');
  await expect(view).toBeVisible();
  await expect(
    view.getByRole('navigation', { name: 'Handboek contents' }).getByRole('button', {
      name: article.title,
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    view.getByRole('heading', { name: article.title, exact: true }).first(),
  ).toBeVisible();
  const doc = view.getByTestId('handboek-doc');
  await expect(doc).toBeVisible();
  await expect(doc).toContainText(article.body);
  await expect(
    view.locator('.handboek-error, .handboek-loading, .handboek-toc-loading'),
  ).toHaveCount(0);
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
