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

    for (const side of ['right', 'left'] as const) {
      await page.evaluate((nextSide) => {
        document.documentElement.dataset.sidebarSide = nextSide;
      }, side);
      const bridge = await page.getByTestId('sidebar-meester').evaluate((home, currentSide) => {
        const sidebar = document.querySelector<HTMLElement>('[data-testid="app-sidebar"]');
        if (!sidebar) throw new Error('Sidebar not found');
        const homeRect = home.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        const homeStyle = getComputedStyle(home);
        const bridgeStyle = getComputedStyle(home, '::after');
        const bridgeWidth = Number.parseFloat(bridgeStyle.width);
        const bridgeTransform =
          bridgeStyle.transform === 'none' ? new DOMMatrix() : new DOMMatrix(bridgeStyle.transform);
        return {
          seamOffset:
            currentSide === 'right'
              ? homeRect.left - bridgeWidth - sidebarRect.left
              : homeRect.right + bridgeWidth - sidebarRect.right,
          topOffset:
            Number.parseFloat(homeStyle.borderTopWidth) +
            Number.parseFloat(bridgeStyle.top) +
            bridgeTransform.m42,
          bottomOffset:
            -Number.parseFloat(homeStyle.borderBottomWidth) -
            Number.parseFloat(bridgeStyle.bottom) +
            bridgeTransform.m42,
        };
      }, side);
      /* The inset divider itself is 1px wide, so either edge may resolve to
         that boundary depending on the mirrored sidebar direction. */
      expect(Math.abs(bridge.seamOffset)).toBeLessThan(1.1);
      expect(Math.abs(bridge.topOffset)).toBeLessThan(0.1);
      expect(Math.abs(bridge.bottomOffset)).toBeLessThan(0.1);
    }
    await page.evaluate(() => {
      document.documentElement.dataset.sidebarSide = 'right';
    });

    const workshopPaper = page.getByTestId('home-workshop');
    await expect
      .poll(() =>
        workshopPaper.evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--paper').trim(),
        ),
      )
      .toBe('#efe6dc');

    await shot(page, 'app-shell', { area: 'shell', description: 'Full app shell, light theme' });

    await setTheme(page, 'dark');
    await expect
      .poll(() =>
        workshopPaper.evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--paper').trim(),
        ),
      )
      .toBe('#1f1c18');
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

    const activeProjectStatus = page.locator('.project-row-status-active').first();
    await activeProjectStatus.hover();
    await expect(page.getByRole('tooltip')).toContainText(
      'Active — automatic project work can run, including scheduled tasks and handoffs.',
    );
    await shot(page, 'sidebar-project-status-tooltip', {
      area: 'shell',
      description: 'Project lifecycle status tooltip',
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
