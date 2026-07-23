/**
 * Gezels — the roster list and the per-gezel detail view (profile, growth,
 * memories). Uses the seeded gezels so avatars/names are stable.
 */
import { expect, test } from './fixtures/test.js';
import { gotoHome, openAreaView, openGezel } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

test.describe('gezels', () => {
  test('list + detail (profile, growth, memories)', async ({ page, world }) => {
    test.skip(!world, 'requires the seeded world');
    await gotoHome(page);

    await openAreaView(page, 'gezels');
    await expect(page.getByTestId('gezels-view')).toBeVisible();

    // Keep the trailing actions control from consuming the row. A broad
    // `.side li button` rule once made the compact menu 100% wide, collapsing
    // the selectable content down to the avatar and hiding every name/role.
    const firstRosterItem = page.locator('.gezel-row-shell').first();
    const rosterButtonBox = await firstRosterItem.locator('.gezel-row').boundingBox();
    const actionsButtonBox = await firstRosterItem
      .locator('.gezel-actions-trigger--row')
      .boundingBox();
    expect(rosterButtonBox?.width).toBeGreaterThan(140);
    expect(actionsButtonBox?.width).toBeLessThan(30);

    await shot(page, 'list', {
      area: 'gezels',
      description: 'Gezels roster — seeded gezels with deterministic poppetje avatars',
    });

    await openGezel(page, world!.gezelIds.ada);
    const detail = page.getByTestId('gezel-detail');
    await expect(detail).toBeVisible();
    await shot(page, 'detail', {
      area: 'gezels',
      clip: detail,
      selector: '[data-testid=gezel-detail]',
      description: 'Gezel detail — profile header, role, tabs (Ada Lovelace)',
    });

    // Growth tab.
    await page.getByRole('tab', { name: /growth/i }).click();
    const growth = page.getByTestId('growth-panel');
    await expect(growth).toBeVisible();
    await shot(page, 'growth', {
      area: 'gezels',
      clip: growth,
      selector: '[data-testid=growth-panel]',
      description: 'Gezel growth panel — level, XP, traits',
    });

    // Memories tab.
    await page.getByRole('tab', { name: /memories/i }).click();
    const memories = page.getByTestId('memories-tree');
    await expect(memories).toBeVisible();
    await shot(page, 'memories', {
      area: 'gezels',
      clip: memories,
      selector: '[data-testid=memories-tree]',
      description: 'Gezel memories tree',
    });
  });
});
