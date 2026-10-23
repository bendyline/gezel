/**
 * Fresh-service DocBlocks inclusion and readable setup requirements. The first
 * test uses the real catalog/Store; the second injects an optional-tool need to
 * exercise the remaining setup flow, including layout and screenshot evidence.
 */
import { planDisplayName } from '@bendyline/gezel';
import { expect, test } from './fixtures/test.js';
import { gotoHome, openAreaView } from './helpers/nav.js';

test.use({ daemonGroup: 'docblocks-setup' });

test('DocBlocks craftbooks are ready on a fresh installation', async ({
  page,
  daemon,
}, testInfo) => {
  let bookName = '';
  let bookQuery = '';
  await page.route('**/api/projects/*/craftbooks', async (route) => {
    const response = await route.fetch();
    const listing = await response.json();
    const book = listing.items.find((item: { manifest: { toolsets?: { toolsetId: string }[] } }) =>
      item.manifest.toolsets?.some((need) => need.toolsetId === 'docblocks'),
    );
    expect(book).toBeTruthy();
    expect(listing.missingToolsets[book.manifest.id] ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ toolsetId: 'docblocks' })]),
    );
    bookName = planDisplayName(book.manifest);
    bookQuery = book.manifest.name;
    await route.fulfill({ response });
  });
  const response = await page.request.get(
    `${daemon.baseURL}/api/catalog/installed-toolsets?scope=system`,
    {
      headers: { Authorization: `Bearer ${daemon.token}` },
    },
  );
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).toolsets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ toolsetId: 'docblocks', sourceId: 'bundled' }),
    ]),
  );
  await gotoHome(page);
  await openAreaView(page, 'tasks');
  await page.getByRole('button', { name: '+ New task' }).click();
  const dialog = page.locator('.gz-ntd');
  await expect.poll(() => bookName).not.toBe('');
  await dialog.getByRole('searchbox', { name: 'Search plans' }).fill(bookQuery);
  await dialog.getByRole('radio', { name: bookName, exact: true }).click();
  await expect(dialog.locator('.gz-npd-hero-name')).toHaveText(bookName);
  await expect(dialog.getByText(/\{\{sourceOutputPath\}\}/)).toHaveCount(0);
  await expect(dialog.locator('.craftbook-toolset-setup')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('docblocks-included.png'), fullPage: true });
});

test('tool requirements use readable words and show their entire description', async ({
  page,
}, testInfo) => {
  let bookName = '';
  let bookQuery = '';
  const reason =
    'convert {{sourceOutputPath}} to MP4 and animated GIF with synchronized narration, then save both finished files in {{task.dir}} for review';
  await page.route('**/api/projects/*/craftbooks', async (route) => {
    const response = await route.fetch();
    const listing = await response.json();
    const book = listing.items.find((item: { manifest: { toolsets?: { toolsetId: string }[] } }) =>
      item.manifest.toolsets?.some((need) => need.toolsetId === 'docblocks'),
    );
    expect(book).toBeTruthy();
    bookName = planDisplayName(book.manifest);
    bookQuery = book.manifest.name;
    listing.missingToolsets[book.manifest.id] = [{ toolsetId: 'video-export', reason }];
    await route.fulfill({ response, json: listing });
  });
  await gotoHome(page);
  await openAreaView(page, 'tasks');
  await page.getByRole('button', { name: '+ New task' }).click();
  const dialog = page.locator('.gz-ntd');
  await expect.poll(() => bookName).not.toBe('');
  await dialog.getByRole('searchbox', { name: 'Search plans' }).fill(bookQuery);
  await dialog.getByRole('radio', { name: bookName, exact: true }).click();
  const description = dialog.locator('.craftbook-toolset-setup .commands-panel-item-desc');
  await expect(description).toHaveText(
    'convert the source document to MP4 and animated GIF with synchronized narration, then save both finished files in the task folder for review',
  );
  await expect(description).toHaveCSS('white-space', 'normal');
  expect(
    await description.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(
    await description.evaluate(
      (element) =>
        element.getBoundingClientRect().height >
        Number.parseFloat(getComputedStyle(element).fontSize) * 2,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('tool-description-wrapped.png'),
    fullPage: true,
  });
});
