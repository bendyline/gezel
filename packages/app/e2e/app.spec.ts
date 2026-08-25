import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));

let app: ElectronApplication;
let page: Page;
let gezelHome: string;

const screenshotDir = join(_dirname, '..', 'screenshots');
const UI_LOAD_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = UI_LOAD_TIMEOUT_MS + 30_000;

test.beforeAll(async () => {
  test.setTimeout(HOOK_TIMEOUT_MS);
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-e2e-'));

  app = await electron.launch({
    args: [join(_dirname, '..')],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      // Force the supervisor into embedded mode for speed. The spawn path
      // has its own dedicated spec.
      GEZEL_EMBEDDED: '1',
      // Keep the smoke hermetic and independent of developer credentials.
      GEZEL_MOCK_PROVIDER: '1',
      // Skip the on-device first-run download (Gemma 4 E4B is ~5 GB) and
      // the system-toolset bootstrap (Chromium tarball). Without this the
      // UI parks on the first-run install wizard and the regular nav
      // never appears.
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    }),
  });

  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // The first window is the splash page, which deliberately shares the final
  // document title. Wait for a UI-only element so a cold embedded-service boot
  // cannot make the title assertion pass before navigation has completed.
  await expect(page.locator('.app-header')).toBeVisible({ timeout: UI_LOAD_TIMEOUT_MS });
});

test.afterAll(async () => {
  // `app.close()` exercises Electron's real before-quit path. The embedded
  // service gets a 30-second graceful-shutdown window before the app forces
  // the final quit, so Playwright's 30-second hook default races that safety
  // wall and can report a teardown failure just as Electron is exiting.
  test.setTimeout(HOOK_TIMEOUT_MS);
  await app?.close();
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('01 - app window opens with correct title', async () => {
  // The BrowserWindow is created before the embedded service is ready and
  // navigates from the splash to the daemon URL. During that handoff Electron
  // briefly exposes a generated "Loading https://…" title, so wait for the
  // served UI's document title instead of snapshotting the transient value.
  await expect(page).toHaveTitle('Gezel');
  await page.screenshot({ path: join(screenshotDir, '01-initial-load.png'), fullPage: true });
});

test('02 - header shows the brand and the left sidebar lists every area', async () => {
  const header = page.locator('.app-header');
  await expect(header).toBeVisible();

  // The status header keeps only the brand mark (routes to Meester home);
  // navigation moved to the left sidebar.
  await expect(header.locator('.app-nav-home-logotype')).toBeVisible();
  await expect(header.locator('.app-nav-hamburger')).toHaveCount(0);

  const sidebar = page.locator('[data-testid="app-sidebar"]');
  await expect(sidebar).toBeVisible();
  await page.screenshot({ path: join(screenshotDir, '02-header.png'), fullPage: true });

  // Groups (with inline lists) + top-level area links.
  await expect(page.locator('[data-testid="sidebar-group-projects"]')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar-group-gezels"]')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar-group-documents"]')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar-area-tasks"]')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar-area-history"]')).toBeVisible();
  await expect(page.locator('[data-testid="sidebar-area-settings"]')).toBeVisible();

  const sidebarText = (await sidebar.textContent()) ?? '';
  expect(sidebarText).not.toContain('Agents');
});

// The native window-control overlay paints a flat sage patch that the
// header's wood-grain texture cannot reach, and it paints only its own
// height and width. Any drift between the header band and that patch shows
// up as a seam — texture peeking out below the buttons, or the cordon rule
// landing a pixel off the boundary. Both are easy to introduce (a vertical
// margin on any header pill grew the band 6px past the overlay once) and
// invisible without measuring, so assert the geometry directly.
test('02b - the header band matches the native window-control overlay', async () => {
  test.skip(process.platform === 'darwin', 'macOS uses traffic lights, not a painted overlay');

  const geometry = await page.evaluate(() => {
    const wco = navigator.windowControlsOverlay;
    if (!wco?.visible) return null;
    const header = document.querySelector('.app-header');
    if (!header) return null;
    const rect = wco.getTitlebarAreaRect();
    const after = getComputedStyle(header, '::after');
    return {
      headerHeight: header.getBoundingClientRect().height,
      overlayHeight: rect.height,
      // Distance from the right window edge to the inner edge of the
      // buttons, and to the cordon rule that is supposed to sit on it.
      overlayInset: header.getBoundingClientRect().width - (rect.x + rect.width),
      ruleInset: Number.parseFloat(after.right),
      ruleWidth: Number.parseFloat(after.width),
    };
  });

  // Older Electron/Chromium or a hidden overlay leaves nothing to compare.
  test.skip(geometry === null, 'window controls overlay unavailable');
  if (!geometry) return;

  expect(geometry.headerHeight).toBeCloseTo(geometry.overlayHeight, 0);
  expect(geometry.ruleInset).toBeCloseTo(geometry.overlayInset, 0);
  expect(geometry.ruleWidth).toBe(1);
});

async function openArea(area: string): Promise<void> {
  await page.locator(`[data-testid="sidebar-area-${area}"]`).click();
}

async function expandGroup(id: string): Promise<void> {
  // The caret button toggles the inline list; the sibling `sidebar-group-${id}`
  // button navigates to the area instead (and carries no aria-expanded).
  const toggle = page.locator(`[data-testid="sidebar-group-toggle-${id}"]`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

test('03 - no error messages on initial load', async () => {
  const errors = page.locator('.error');
  const errorCount = await errors.count();
  if (errorCount > 0) {
    const errorTexts = await errors.allTextContents();
    console.log('Errors found:', errorTexts);
  }
  await page.screenshot({ path: join(screenshotDir, '03-no-errors.png'), fullPage: true });
  expect(errorCount).toBe(0);
});

test('04 - gezels list loads without JSON parse error', async () => {
  await expandGroup('gezels');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(screenshotDir, '04-gezels.png'), fullPage: true });

  // Should NOT see "Unexpected token" or "not valid JSON"
  const body = await page.textContent('body');
  expect(body).not.toContain('Unexpected token');
  expect(body).not.toContain('not valid JSON');
});

test('05 - can create a gezel via the sidebar "+"', async () => {
  // The Gezels group "+" opens the Gezels view and pops the create dialog.
  await page.locator('[aria-label="New gezel"]').click();
  await page.waitForTimeout(300);
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  // Clear the pre-filled random name and type ours.
  await dialog.locator('input').first().fill('TestBot');
  await dialog.locator('button:has-text("Create")').click();
  // handleCreate awaits createGezel, then dismisses the dialog (setShowCreate(false)).
  // Waiting for the dialog to disappear is a deterministic "create resolved" signal —
  // far more robust than a fixed sleep (the old source of the flake).
  await expect(dialog).toBeHidden();
  await page.screenshot({ path: join(screenshotDir, '05-gezel-created.png'), fullPage: true });

  // The new gezel flows back into the sidebar list via the async
  // `gezel:gezel-updated` event, which can lag the dialog close under cold-start
  // load. Web-first assertion with headroom so we retry until the event lands.
  await expandGroup('gezels');
  await expect(page.locator('[data-testid="app-sidebar"]')).toContainText('TestBot', {
    timeout: 15_000,
  });
});

test('06 - settings area loads', async () => {
  await openArea('settings');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(screenshotDir, '06-settings.png'), fullPage: true });

  const body = await page.textContent('body');
  expect(body).toContain('GitHub Copilot');
  expect(body).toContain('OpenAI');
  expect(body).toContain('Ollama');
  expect(body).not.toContain('Longview');
});

test('07 - projects group hides the built-in default project', async () => {
  // The "Default" project is an always-present scratchpad, not a user-created
  // project, so the sidebar hides it (HIDDEN_PROJECT_IDS in Sidebar.tsx). With
  // no user projects in a fresh home dir, the group shows its empty state.
  await expandGroup('projects');
  await page.screenshot({ path: join(screenshotDir, '07-projects.png'), fullPage: true });

  const sidebar = page.locator('[data-testid="app-sidebar"]');
  await expect(sidebar).toContainText('No projects yet');
  await expect(sidebar).not.toContainText('Default');
});

test('08 - brand routes to the meester home', async () => {
  await page.locator('.app-header-brand').click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(screenshotDir, '08-home.png'), fullPage: true });

  const body = await page.textContent('body');
  expect(body).not.toContain('Unexpected token');
});

test('09 - no old branding anywhere', async () => {
  // Home + each area, snapshotting the body so any stray "Longview" /
  // "Agents" branding shows up in the aggregated text.
  await page.locator('.app-header-brand').click();
  await page.waitForTimeout(500);
  await expandGroup('gezels');
  await expandGroup('projects');
  for (const area of ['tasks', 'settings']) {
    await openArea(area);
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: join(screenshotDir, '09-final-state.png'), fullPage: true });

  const fullText = await page.textContent('body');
  expect(fullText).not.toContain('Longview');
  expect(fullText).not.toContain('Agents');
});
