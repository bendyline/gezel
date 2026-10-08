import { type Page, expect } from '@playwright/test';

/** The bundled catalog, selected article, parsed prose, and inline assets are ready. */
export async function expectHandboekArticle(
  page: Page,
  article?: { title: string },
): Promise<void> {
  const view = page.getByTestId('knowledge-view');
  await expect(view).toBeVisible();
  await expect(view.locator('.knowledge-catalog-name')).toHaveText('Gezel Handboek');
  await expect(view.getByRole('region', { name: 'Article' })).toHaveAttribute('aria-busy', 'false');
  const heading = view.locator('.knowledge-reader-header h2');
  await expect(heading).toBeVisible();
  if (article) await expect(heading).toHaveText(article.title);
  const doc = view.locator('.knowledge-reader-body');
  await expect(doc).toBeVisible();
  await expect(doc).toContainText(/\S/);
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
