/**
 * Projects IDE — the two-column project view and its entity tabs. One page-level
 * frame per tab so the gallery shows each surface in context.
 */
import { expect, test } from './fixtures/test.js';
import { settle } from './helpers/determinism.js';
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
  test('tab tour', async ({ page, world }) => {
    test.skip(!world, 'requires the seeded world');
    await gotoHome(page);
    await openProject(page, world!.projectId);

    await expect(page.getByTestId('project-tab-chat')).toBeVisible({ timeout: 15_000 });
    const activeProjectBridge = await page
      .locator('.app-sidebar-proj-row.active')
      .evaluate((row) => {
        const rowStyle = getComputedStyle(row);
        const bridgeStyle = getComputedStyle(row, '::after');
        return {
          topOffset:
            Number.parseFloat(rowStyle.borderTopWidth) + Number.parseFloat(bridgeStyle.top),
          bottomOffset:
            -Number.parseFloat(rowStyle.borderBottomWidth) - Number.parseFloat(bridgeStyle.bottom),
        };
      });
    expect(Math.abs(activeProjectBridge.topOffset)).toBeLessThan(0.1);
    expect(Math.abs(activeProjectBridge.bottomOffset)).toBeLessThan(0.1);

    for (const t of TABS) {
      const trigger = page.getByTestId(`project-tab-${t.value}`);
      await expect(trigger).toBeVisible();
      await trigger.click();
      await settle(page);
      await shot(page, t.name, { area: 'projects', description: t.desc });
    }
  });
});
