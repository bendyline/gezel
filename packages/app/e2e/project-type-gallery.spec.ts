import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';
import { captureScreenshot } from './helpers/screenshot.js';

/**
 * End-to-end: the custom-project-type New Project gallery + the Output-pane
 * dashboard pin, exercised against the shipped Language Trainer type. Proves
 * the whole chain — catalog listing → gallery chip → apply engine → pinned
 * type-preview dashboard — renders in the real Electron shell. See
 * docs/project-types.md.
 */

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

test.setTimeout(90_000);

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-project-type-e2e-'));
  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  await closeApp(app);
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('gallery lists the Language Trainer type and creates a project with a pinned dashboard', async () => {
  // Open the Projects area, then the New Project dialog via its canonical event.
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('gezel:open-tab', { detail: { kind: 'area', area: 'projects' } }),
    );
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gezel:new-project')));

  // The gallery renders the bundled Language Trainer type as a selectable card.
  const card = page.getByRole('radio', { name: 'Language Trainer' });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await captureScreenshot(page, { path: '/tmp/gezel-project-type-gallery.png', fullPage: false });

  // Selecting it hides the free-form About/Mission and shows the type's copy.
  await card.click();
  // Picking a card advances the dialog to its configure step, where the
  // selection is identified by the detail header rather than the (now
  // unmounted) gallery card.
  await expect(page.getByRole('heading', { name: 'Language Trainer' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue(
    'Spanish Language Trainer',
  );

  // Name it and create. The `language` param defaults to "Spanish", so the
  // seeded form is enough — no manual param entry needed.
  await page.getByPlaceholder(/Pet Shop|prototype/).fill('Learn Spanish');
  await page.getByRole('button', { name: /^Create/ }).click();

  // After creation the project view shows the Output pane pinned to the
  // type's dashboard (served from the type source). The dashboard renders
  // "Level" / "Sessions" / "Day streak" tiles inside the sandboxed iframe.
  const outputFrame = page.frameLocator('iframe.project-output-iframe');
  await expect(outputFrame.getByText('Level')).toBeVisible({ timeout: 20_000 });
  await expect(outputFrame.getByText('Day streak')).toBeVisible();
  // The `language` param default ("Spanish") is substituted into the seeded
  // progress.json the dashboard reads — no literal `{{language}}` leaks.
  await expect(outputFrame.getByText('Learning Spanish')).toBeVisible();
  await expect(outputFrame.getByText('{{')).toHaveCount(0);

  // Applying the type also creates its Language Trainer gezel. The global
  // sidebar must invalidate its roster after apply (the earlier
  // project-created event fires before this gezel exists).
  await page.getByTestId('sidebar-group-toggle-gezels').click();
  await expect(page.locator('[data-testid="app-sidebar"]')).toContainText('Language Trainer');
  await captureScreenshot(page, { path: '/tmp/gezel-project-type-dashboard.png', fullPage: false });
});

test('gallery creates a Job Hunt project: two-gezel crew and the pipeline board', async () => {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('gezel:open-tab', { detail: { kind: 'area', area: 'projects' } }),
    );
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gezel:new-project')));

  // The bundled Job Hunt type renders under its `growth` category card set.
  const card = page.getByRole('radio', { name: 'Job Hunt' });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await expect(page.getByRole('heading', { name: 'Job Hunt' })).toBeVisible();
  // nameTemplate + the role param default drive the suggested name.
  await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue(
    'Software Engineer Job Hunt',
  );

  await page.getByRole('button', { name: /^Create/ }).click();

  // The pinned dashboard is the pipeline board: one column per stage, seeded
  // empty, with the coach-voiced empty state and no template placeholders.
  const outputFrame = page.frameLocator('iframe.project-output-iframe');
  await expect(outputFrame.getByText('Applied')).toBeVisible({ timeout: 20_000 });
  await expect(outputFrame.getByText('Screening')).toBeVisible();
  await expect(outputFrame.getByText('Interview', { exact: true })).toBeVisible();
  await expect(outputFrame.getByText('Offer', { exact: true })).toBeVisible();
  await expect(outputFrame.getByText(/tell your Loopbaancoach/)).toBeVisible();
  await expect(outputFrame.getByText('{{')).toHaveCount(0);

  // The two-gezel crew materialized: coach voorman + mock interviewer both
  // land on the sidebar roster.
  await expect(page.locator('[data-testid="app-sidebar"]')).toContainText('Loopbaancoach');
  await expect(page.locator('[data-testid="app-sidebar"]')).toContainText('Oefen-interviewer');
  await captureScreenshot(page, { path: '/tmp/gezel-job-hunt-dashboard.png', fullPage: false });
});
