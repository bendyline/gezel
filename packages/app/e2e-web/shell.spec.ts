/**
 * App shell — the persistent header + sidebar that frame every view. Light and
 * dark full-frame shots plus element clips of the header and sidebar.
 */
import { expect, test } from './fixtures/test.js';
import { setTheme } from './helpers/determinism.js';
import { gotoHome } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

test.describe('app shell', () => {
  test('shell, header, sidebar (light + dark)', async ({ page }) => {
    await gotoHome(page);

    await expect(page.getByTestId('app-sidebar')).toBeVisible();
    await expect(page.getByTestId('app-header')).toBeVisible();

    await shot(page, 'app-shell', { area: 'shell', description: 'Full app shell, light theme' });

    await setTheme(page, 'dark');
    await shot(page, 'app-shell', {
      area: 'shell',
      theme: 'dark',
      description: 'Full app shell, dark theme',
    });
    await setTheme(page, 'light');

    await shot(page, 'header', {
      area: 'shell',
      clip: page.getByTestId('app-header'),
      selector: '[data-testid=app-header]',
      description: 'Top header bar — brand mark + status pills (volatile pills masked)',
    });

    await shot(page, 'sidebar-expanded', {
      area: 'shell',
      clip: page.getByTestId('app-sidebar'),
      selector: '[data-testid=app-sidebar]',
      description: 'Left navigation sidebar with groups expanded',
    });

    await shot(page, 'sidebar-meester', {
      area: 'shell',
      clip: page.getByTestId('sidebar-meester'),
      selector: '[data-testid=sidebar-meester]',
      description: 'Meester home link at the top of the sidebar',
    });
  });

  test('sidebar collapsed', async ({ page }) => {
    // The sidebar reads its collapsed state from localStorage ('1' = collapsed).
    await page.addInitScript(() => {
      try {
        localStorage.setItem('gezel:nav:sidebar-collapsed', '1');
      } catch {
        /* ignore */
      }
    });
    await gotoHome(page);
    await shot(page, 'sidebar-collapsed', {
      area: 'shell',
      clip: page.getByTestId('app-sidebar'),
      selector: '[data-testid=app-sidebar]',
      description: 'Left sidebar collapsed to icon rail',
    });
  });
});
