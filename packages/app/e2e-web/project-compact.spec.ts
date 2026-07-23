/**
 * Projects IDE at a narrow viewport — the compact layout folds the output pane
 * into a tab and swaps tab labels for icons. Runs only under the `narrow`
 * Playwright project (820px); see playwright.web.config.ts (testMatch /compact/).
 */
import { expect, test } from './fixtures/test.js';
import { gotoHome, openProject } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

test.describe('projects IDE (compact)', () => {
  test('compact layout', async ({ page, world }) => {
    test.skip(!world, 'requires the seeded world');
    await gotoHome(page);
    await openProject(page, world!.projectId);
    await expect(page.getByTestId('project-tab-chat')).toBeVisible({ timeout: 15_000 });
    await shot(page, 'ide-compact', {
      area: 'projects',
      viewport: 'narrow',
      description: 'Project IDE at a narrow viewport — compact tab/icon layout',
    });
  });
});
