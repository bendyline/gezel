/**
 * Tasks — the cross-project task list and a task's detail view (step tracker +
 * step panel). Uses the seeded tasks.
 */
import { expect, test } from './fixtures/test.js';
import { gotoHome, openAreaView, openTask } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

test.describe('tasks', () => {
  test('list + detail (step tracker, step panel)', async ({ page, world }) => {
    test.skip(!world, 'requires the seeded world');
    await gotoHome(page);

    await openAreaView(page, 'tasks');
    await expect(page.getByTestId('tasks-view')).toBeVisible();
    await shot(page, 'list', {
      area: 'tasks',
      description: 'Tasks list — seeded tasks across the fixture project',
    });

    await openTask(page, world!.taskRefs[0]!);
    const detail = page.getByTestId('task-detail');
    await expect(detail).toBeVisible();
    await shot(page, 'detail', {
      area: 'tasks',
      description: 'Task detail — header, step tracker, description, notes',
    });

    await shot(page, 'step-tracker', {
      area: 'tasks',
      clip: page.locator('.step-tracker').first(),
      selector: '.step-tracker',
      description: 'Task step tracker — the craftbook phases (Plan → Build → Review)',
    });

    // A task now opens on the Task overview; select a step on the bench to
    // reveal its panel before capturing it.
    await page.locator('.step-tracker .bench-step-marker').first().click();
    await expect(page.getByTestId('task-step-panel')).toBeVisible();
    await shot(page, 'step-panel', {
      area: 'tasks',
      clip: page.getByTestId('task-step-panel'),
      selector: '[data-testid=task-step-panel]',
      description: 'Task step panel — the active phase detail',
    });
  });

  test('new-task dialog: craftbook gallery → create draft → fire', async ({ page, world }) => {
    test.skip(!world, 'requires the seeded world');
    await gotoHome(page);

    await openAreaView(page, 'tasks');
    await expect(page.getByTestId('tasks-view')).toBeVisible();
    await page.getByRole('button', { name: '+ New task' }).click();

    // The gallery dialog: general card + the real bundled craftbook catalog.
    const dialog = page.locator('.gz-ntd');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'General task' })).toBeVisible();
    await shot(page, 'new-dialog', {
      area: 'tasks',
      description: 'New Task dialog — craftbook gallery with rail, cards, and properties pane',
    });

    // Whether or not a recommended shelf resolved for the fixture project,
    // the full catalog is one rail click away.
    await dialog.getByRole('button', { name: /All craftbooks/ }).click();
    // Use a setup-free catalog book for the create-and-fire path. Books such
    // as Accessibility Audit deliberately disable creation until their
    // required toolsets are installed; that setup gate has separate coverage.
    const bookCard = dialog.getByRole('radio', { name: 'A/B Ad Copy Variations' });
    await expect(bookCard).toBeVisible();

    // Selecting a craftbook fills the pane: recipe steps + suggested title.
    await bookCard.click();
    await expect(dialog.locator('.gz-ntd-steps')).toBeVisible();
    await expect(dialog.locator('.gz-npd-hero-name')).toHaveText('A/B Ad Copy Variations');
    await shot(page, 'new-dialog-craftbook', {
      area: 'tasks',
      description: 'New Task dialog — a selected craftbook previewing its recipe steps',
    });

    await dialog.getByRole('button', { name: 'Create task' }).click();
    await expect(dialog).not.toBeVisible();

    // The created task lands ready to fire (an inert draft), and firing
    // activates it — a catalog book needs no guardrail override.
    const detail = page.getByTestId('task-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.task-detail-status-badge')).toHaveText('ready');
    await detail.getByRole('button', { name: 'Fire task' }).click();
    await expect(detail.locator('.task-detail-status-badge')).toHaveCount(0);
    const status = detail.getByRole('radiogroup', { name: 'Task status' });
    await expect(status.getByRole('radio', { name: 'Active' })).toBeChecked();
  });
});
