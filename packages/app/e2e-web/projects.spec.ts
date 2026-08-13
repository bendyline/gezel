/**
 * Projects IDE — the two-column project view and its entity tabs. One page-level
 * frame per tab so the gallery shows each surface in context.
 */
import { expect, test } from './fixtures/test.js';
import { setTheme, settle } from './helpers/determinism.js';
import { gotoHome, openProject } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

const TABS = [
  { value: 'chat', name: 'ide-chat', desc: 'Project IDE — Chat tab (project-scoped conversation)' },
  { value: 'tasks', name: 'ide-tasks', desc: 'Project IDE — Tasks tab' },
  { value: 'workspace', name: 'ide-workspace', desc: 'Project IDE — Workspace file browser' },
  { value: 'artifacts', name: 'ide-artifacts', desc: 'Project IDE — Artifacts tab' },
  {
    value: 'about',
    name: 'ide-about',
    desc: 'Project IDE — Settings tab (project brief, history, and settings sections)',
  },
];

test.describe('projects IDE', () => {
  test('restored Default workspace stays named in the project navigation', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'gezel:nav:selection',
        JSON.stringify({ kind: 'project', id: 'default', at: Date.now(), order: 0 }),
      );
    });
    await page.goto('/');

    await expect(page.getByTestId('project-tab-chat')).toBeVisible({ timeout: 15_000 });
    const currentProject = page.locator(
      '.app-sidebar-proj-row.active > .app-sidebar-item[aria-current="page"]',
    );
    await expect(currentProject.locator('.app-sidebar-item-label')).toHaveText('Default');
  });

  test('tab tour', async ({ page, world }) => {
    test.skip(!world, 'requires the seeded world');
    await gotoHome(page);
    await openProject(page, world!.projectId);

    await expect(page.getByTestId('project-tab-chat')).toBeVisible({ timeout: 15_000 });
    const activeProjectRow = page.locator('.app-sidebar-proj-row.active');
    for (const side of ['right', 'left'] as const) {
      await page.evaluate((nextSide) => {
        document.documentElement.dataset.sidebarSide = nextSide;
      }, side);
      const connectedEdge = await activeProjectRow.evaluate((row, currentSide) => {
        const sidebar = document.querySelector<HTMLElement>('[data-testid="app-sidebar"]');
        if (!sidebar) throw new Error('Sidebar not found');
        const rowRect = row.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        return currentSide === 'right'
          ? rowRect.left - sidebarRect.left
          : rowRect.right - sidebarRect.right;
      }, side);
      expect(Math.abs(connectedEdge)).toBeLessThan(1.1);
    }
    await page.evaluate(() => {
      document.documentElement.dataset.sidebarSide = 'right';
    });
    const unfocusedProject = await activeProjectRow.evaluate((row) => {
      const style = getComputedStyle(row);
      const button = row.querySelector<HTMLElement>(':scope > .app-sidebar-item.active');
      return {
        borderTopColor: style.borderTopColor,
        boxShadow: style.boxShadow,
        filter: style.filter,
        buttonFilter: button ? getComputedStyle(button).filter : null,
      };
    });
    expect(unfocusedProject.boxShadow).toBe('none');
    expect(unfocusedProject.filter).toBe('none');
    expect(unfocusedProject.buttonFilter).toBe('none');

    const activeProjectButton = activeProjectRow.locator(':scope > .app-sidebar-item.active');
    await page.keyboard.press('Tab');
    await activeProjectButton.focus();
    await expect
      .poll(() => activeProjectButton.evaluate((button) => button.matches(':focus-visible')))
      .toBe(true);

    const activeProjectFocus = await activeProjectRow.evaluate((row) => {
      const rowStyle = getComputedStyle(row);
      const button = row.querySelector<HTMLElement>(':scope > .app-sidebar-item.active');
      const openEdgeColor =
        document.documentElement.dataset.sidebarSide === 'right'
          ? rowStyle.borderLeftColor
          : rowStyle.borderRightColor;
      return {
        openEdgeColor,
        borderTopColor: rowStyle.borderTopColor,
        rowShadow: rowStyle.boxShadow,
        rowFilter: rowStyle.filter,
        buttonShadow: button ? getComputedStyle(button).boxShadow : null,
        buttonFilter: button ? getComputedStyle(button).filter : null,
      };
    });
    expect(activeProjectFocus.rowShadow).toBe('none');
    expect(activeProjectFocus.rowFilter).toBe('none');
    expect(activeProjectFocus.buttonShadow).toBe('none');
    expect(activeProjectFocus.buttonFilter).toBe('none');
    expect(activeProjectFocus.openEdgeColor).toBe('rgba(0, 0, 0, 0)');
    expect(activeProjectFocus.borderTopColor).not.toBe(unfocusedProject.borderTopColor);

    await setTheme(page, 'dark');
    await shot(page, 'ide-chat', {
      area: 'projects',
      theme: 'dark',
      description: 'Project IDE — Chat tab, dark theme with connected project row',
    });
    await setTheme(page, 'light');

    for (const t of TABS) {
      const trigger = page.getByTestId(`project-tab-${t.value}`);
      await expect(trigger).toBeVisible();
      await trigger.click();
      await settle(page);
      await shot(page, t.name, { area: 'projects', description: t.desc });
    }
  });
});
