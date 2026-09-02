import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * UX tour — one serialized pass over every major user-facing surface in a
 * "warm" (configured, lived-in) install. Each stop asserts the surface's
 * signature element so the suite fails when an area breaks, and captures a
 * screenshot into `screenshots/ux-tour/warm/` for human UX review.
 *
 * The folder is wiped at the start of the run so a review always looks at
 * one coherent set — never a mix of two builds. First-run onboarding has
 * its own spec (`ux-first-run.spec.ts`) writing to a sibling folder, since
 * it needs a launch env this warm world must not share.
 *
 * The warm world is built through the UI itself (create a gezel, create a
 * project, send a chat turn), which doubles as coverage of those creation
 * flows. Mock provider keeps it hermetic.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';
import { captureScreenshot } from './helpers/screenshot.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(_dirname, '..');
const shotDir = join(appRoot, 'screenshots', 'ux-tour', 'warm');

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

async function shot(name: string, fullPage = true): Promise<void> {
  await captureScreenshot(page, { path: join(shotDir, name), fullPage });
}

async function openArea(area: string): Promise<void> {
  await page.evaluate((a) => {
    window.dispatchEvent(new CustomEvent('gezel:open-tab', { detail: { kind: 'area', area: a } }));
  }, area);
}

test.beforeAll(async () => {
  test.setTimeout(90_000);
  // The run-scoped wipe lives in globalSetup (clean-ux-tour-shots.ts) — a
  // beforeAll wipe would re-run on failure-triggered worker restarts and
  // delete the shots already captured.
  await mkdir(shotDir, { recursive: true });

  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-ux-tour-e2e-'));
  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
      // The tour sends one chat turn; don't let post-turn memory extraction
      // hold app shutdown or spam the mock transcript with fake facts.
      GEZEL_DISABLE_MEMORY_EXTRACTION: '1',
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible({ timeout: 30_000 });
  // A stable window size so screenshots are comparable across runs.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.setContentSize(1440, 900);
  });
});

test.afterAll(async () => {
  await closeApp(app);
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('01 - home workshop renders and a chat turn round-trips', async () => {
  test.setTimeout(120_000);
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Good (morning|afternoon|evening)\./)).toBeVisible();
  await shot('01-home-workshop.png');

  const editor = page.locator('.squisq-wysiwyg-editor').first();
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type('Hello! What can you help me with around here?');
  await page.keyboard.press('Enter');

  const reply = page
    .locator('.msg-from-gezel, .msg-assistant')
    .filter({ hasText: 'Mock reply:' })
    .last();
  await expect(reply).toBeVisible({ timeout: 90_000 });
  await shot('02-home-chat-reply.png');
});

test('02 - the home tour tab shows the intro article', async () => {
  const tour = page.getByRole('tab', { name: /New here/ });
  await tour.click();
  await expect(page.getByRole('button', { name: /Open in Handboek/ })).toBeVisible({
    timeout: 15_000,
  });
  await shot('03-home-tour-article.png');
  // Back to the default greeting tab for later dark-mode shots.
  await page.getByRole('tab').first().click();
});

test('03 - sidebar groups expand and list entities', async () => {
  for (const id of ['projects', 'gezels', 'documents']) {
    const toggle = page.locator(`[data-testid="sidebar-group-toggle-${id}"]`);
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  await expect(page.locator('[data-testid="sidebar-group-gezels"]')).toBeVisible();
  await shot('04-sidebar-expanded.png');
});

test('04 - new-gezel dialog creates a gezel; its detail tab opens', async () => {
  test.setTimeout(60_000);
  await page.locator('[aria-label="New gezel"]').click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  await shot('05-new-gezel-dialog.png');

  await dialog.locator('input').first().fill('Tessa');
  await dialog.locator('button:has-text("Create")').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-testid="app-sidebar"]')).toContainText('Tessa', {
    timeout: 15_000,
  });

  await page.locator('[data-testid="app-sidebar"]').getByText('Tessa').first().click();
  await page.waitForTimeout(1_200);
  await shot('06-gezel-detail.png');
});

test('05 - gezels area lists the crew', async () => {
  await openArea('gezels');
  await expect(page.getByTestId('gezels-view')).toBeVisible({ timeout: 15_000 });
  await shot('07-gezels-area.png');
});

test('06 - new-project gallery walks its two steps and creates a project', async () => {
  test.setTimeout(90_000);
  await openArea('projects');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gezel:new-project')));

  // Step 1: the type gallery. Anchor on a bundled type by name — the rail's
  // filter keys are radios too, so `.first()` would grab a shelf, not a card.
  const card = page.getByRole('radio', { name: 'Language Trainer' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  // Let the dialog's ~150ms entrance fade settle so the shot isn't washed out.
  await page.waitForTimeout(500);
  await shot('08-new-project-gallery.png');

  await card.click();
  // Step 2: the configure form.
  const nameInput = page.getByRole('textbox', { name: /^Name/ });
  await expect(nameInput).toBeVisible({ timeout: 10_000 });
  await shot('09-new-project-configure.png');

  await nameInput.fill('Tour Project');
  await page.getByRole('button', { name: /^Create/ }).click();
  await page.waitForTimeout(2_500);
  await shot('10-project-view.png');
  await expect(page.locator('[data-testid="app-sidebar"]')).toContainText('Tour Project', {
    timeout: 15_000,
  });
});

test('07 - tasks area and the new-task gallery', async () => {
  await openArea('tasks');
  await expect(page.getByTestId('tasks-view')).toBeVisible({ timeout: 15_000 });
  await shot('11-tasks-area.png');

  const newTask = page.getByRole('button', { name: '+ New task' });
  if (await newTask.isEnabled()) {
    await newTask.click();
    await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(800);
    await shot('12-new-task-gallery.png');
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="dialog"]')).toBeHidden();
  }
});

test('08 - remaining areas render their views', async () => {
  test.setTimeout(120_000);
  const stops: Array<{ area: string; testid: string; file: string }> = [
    { area: 'documents', testid: 'documents-view', file: '13-documents.png' },
    { area: 'craftbooks', testid: 'craftbooks-view', file: '14-craftbooks.png' },
    { area: 'scripts', testid: 'scripts-view', file: '15-scripts.png' },
    { area: 'history', testid: 'history-view', file: '16-history.png' },
    { area: 'knowledge', testid: 'knowledge-view', file: '17-knowledge.png' },
    { area: 'handboek', testid: 'handboek-view', file: '18-handboek.png' },
  ];
  for (const stop of stops) {
    await openArea(stop.area);
    await expect(page.getByTestId(stop.testid)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(700);
    await shot(stop.file);
  }
  // Benchmarks is deliberately not toured: it is a debug-gated developer
  // surface (TabContent routes it to Settings without debugMode).
});

test('09 - titlebar search opens the palette', async () => {
  const input = page.locator('[data-testid="titlebar-search-input"]');
  await expect(input).toBeVisible();
  await input.click();
  await input.fill('tour');
  await expect(page.locator('[data-testid="search-palette"]')).toBeVisible({ timeout: 10_000 });
  await shot('20-search-palette.png');
  await page.keyboard.press('Escape');
});

test('10 - every settings section renders', async () => {
  test.setTimeout(180_000);
  await openArea('settings');
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);

  // The nav's button set shifts as probes resolve (engine sections appear,
  // group toggles carry no label) — re-resolve by index on every pass and
  // key screenshots by label so a mid-run change can't misfile a shot.
  const seen = new Set<string>();
  for (let i = 0; ; i += 1) {
    const buttons = page.locator('.settings-nav .settings-nav-item');
    if (i >= (await buttons.count())) break;
    const btn = buttons.nth(i);
    const label = ((await btn.textContent()) ?? '').trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    await btn.click();
    await page.waitForTimeout(500);
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    await shot(`21-settings-${slug}.png`);
  }
  expect(seen.size).toBeGreaterThanOrEqual(5);
});

test('11 - dark mode variants of the key surfaces', async () => {
  test.setTimeout(90_000);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

  await page.locator('.app-header-brand').click();
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(700);
  await shot('40-dark-home.png');

  await openArea('gezels');
  await expect(page.getByTestId('gezels-view')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('41-dark-gezels.png');

  await openArea('settings');
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('42-dark-settings.png');

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
});
