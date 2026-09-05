/**
 * Gallery frames for the surfaces the original tour skipped: the remaining
 * project IDE tabs (Overview, Approvals, Village) and the Handboek area.
 */
import { expect, test } from './fixtures/test.js';
import { settle } from './helpers/determinism.js';
import { expectHandboekArticle } from './helpers/handboek.js';
import { gotoHome, openArea, openProject } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

const EXTRA_TABS = [
  { value: 'overview', name: 'ide-overview', desc: 'Project IDE — Overview tab' },
  { value: 'approvals', name: 'ide-approvals', desc: 'Project IDE — Approvals tab' },
  { value: 'map', name: 'ide-village', desc: 'Project IDE — Village map of the workspace' },
];

test.describe('audit extras', () => {
  test('remaining project tabs', async ({ page, world }) => {
    test.skip(!world, 'requires the seeded world');
    await gotoHome(page);
    await openProject(page, world!.projectId);
    await expect(page.getByTestId('project-tab-chat')).toBeVisible({ timeout: 15_000 });

    for (const t of EXTRA_TABS) {
      const trigger = page.getByTestId(`project-tab-${t.value}`);
      if (!(await trigger.isVisible().catch(() => false))) continue;
      await trigger.click();
      await settle(page);
      // The village map renders async; give it a beat before framing.
      if (t.value === 'map') await page.waitForTimeout(2000);
      await shot(page, t.name, { area: 'projects', description: t.desc });
    }
  });

  test('handboek home', async ({ page }) => {
    await gotoHome(page);
    await openArea(page, 'handboek');
    await expectHandboekArticle(page);
    await shot(page, 'home', { area: 'handboek', description: 'Handboek — in-app manual home' });
  });
});
