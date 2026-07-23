/**
 * Home / workshop — the meester dashboard: greeting band (frozen clock), the
 * meester conversation column.
 */
import { expect, test } from './fixtures/test.js';
import { setTheme } from './helpers/determinism.js';
import { gotoHome } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

test.describe('home / workshop', () => {
  test('workshop and greeting', async ({ page }) => {
    await gotoHome(page);

    // The frozen clock pins the greeting to the afternoon.
    await expect(page.getByTestId('greeting-band')).toContainText('afternoon', {
      ignoreCase: true,
    });

    await shot(page, 'workshop', {
      area: 'home',
      description: 'Home workshop — greeting band and meester conversation',
    });

    await setTheme(page, 'dark');
    await shot(page, 'workshop', {
      area: 'home',
      theme: 'dark',
      description: 'Home workshop, dark theme',
    });
    await setTheme(page, 'light');

    await shot(page, 'greeting-band', {
      area: 'home',
      clip: page.getByTestId('greeting-band'),
      selector: '[data-testid=greeting-band]',
      description: 'Greeting band — time-of-day headline (frozen to "Good afternoon")',
    });

    await shot(page, 'meester-chat', {
      area: 'home',
      clip: page.getByTestId('meester-chat'),
      selector: '[data-testid=meester-chat]',
      description: 'Meester conversation column with the seeded exchange',
    });
  });
});
