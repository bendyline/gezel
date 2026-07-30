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

    const connectedTabs = [
      {
        trigger: null,
        tab: page.getByTestId('sidebar-meester'),
      },
      {
        trigger: page.getByTestId('sidebar-area-history'),
        tab: page.getByTestId('sidebar-area-history'),
      },
      {
        trigger: page.getByTestId('sidebar-group-documents'),
        tab: page.locator('.app-sidebar-group[data-group="documents"] > .app-sidebar-group-header'),
      },
      {
        trigger: page.getByTestId('sidebar-group-gezels'),
        tab: page.locator('.app-sidebar-group[data-group="gezels"] > .app-sidebar-group-header'),
      },
    ];

    for (const { trigger, tab } of connectedTabs) {
      await trigger?.click();
      await expect(tab).toHaveClass(/active/);
      for (const side of ['right', 'left'] as const) {
        await page.evaluate((nextSide) => {
          document.documentElement.dataset.sidebarSide = nextSide;
        }, side);
        const connectedEdge = await tab.evaluate((element, currentSide) => {
          const sidebar = document.querySelector<HTMLElement>('[data-testid="app-sidebar"]');
          if (!sidebar) throw new Error('Sidebar not found');
          const tabRect = element.getBoundingClientRect();
          const sidebarRect = sidebar.getBoundingClientRect();
          return {
            seamOffset:
              currentSide === 'right'
                ? tabRect.left - sidebarRect.left
                : tabRect.right - sidebarRect.right,
            pseudoDisplay: getComputedStyle(element, '::after').display,
          };
        }, side);
        /* The inset divider itself is 1px wide, so either edge may resolve to
           that boundary depending on the mirrored sidebar direction. */
        expect(Math.abs(connectedEdge.seamOffset)).toBeLessThan(1.1);
        expect(connectedEdge.pseudoDisplay).toBe('none');
      }
    }
    await page.getByTestId('sidebar-meester').click();
    await expect(page.getByTestId('home-workshop')).toBeVisible();
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
    const home = page.getByTestId('sidebar-meester');
    const unfocusedHome = await home.evaluate((element) => {
      const style = getComputedStyle(element);
      return { borderTopColor: style.borderTopColor, boxShadow: style.boxShadow };
    });
    await page.keyboard.press('Tab');
    await home.focus();
    await expect
      .poll(() => home.evaluate((element) => element.matches(':focus-visible')))
      .toBe(true);
    const focusedHome = await home.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderTopColor: style.borderTopColor,
        borderLeftColor: style.borderLeftColor,
        boxShadow: style.boxShadow,
      };
    });
    expect(focusedHome.borderLeftColor).toBe('rgba(0, 0, 0, 0)');
    expect(focusedHome.borderTopColor).not.toBe(unfocusedHome.borderTopColor);
    expect(focusedHome.boxShadow).toBe(unfocusedHome.boxShadow);
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
