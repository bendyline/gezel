import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * First-run onboarding tour — what a brand-new user sees on their first
 * boot, before any provider works. Asserts the load-bearing pieces of the
 * flow and captures screenshots into `screenshots/ux-tour/first-run/` for
 * UX review (the warm-state twin is `ux-tour.spec.ts`).
 *
 * The packaged first boot pins `config.provider` to the on-device engine
 * with a recommended model (`bootstrapOnDeviceFirstRun`), then waits for an
 * explicit click before downloading anything. Tests skip that bootstrap
 * (GEZEL_SKIP_SYSTEM_BOOTSTRAP), so this spec seeds the same pin into
 * config.json by hand — the "needs-download" banner it produces is inert
 * until clicked, which this spec never does, so nothing multi-GB happens.
 * No mock provider: a real-but-unconfigured llama-cpp is exactly the state
 * a fresh install is in.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';
import { captureScreenshot } from './helpers/screenshot.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(_dirname, '..');
const shotDir = join(appRoot, 'screenshots', 'ux-tour', 'first-run');

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

async function shot(name: string): Promise<void> {
  await captureScreenshot(page, { path: join(shotDir, name), fullPage: true });
}

test.beforeAll(async () => {
  test.setTimeout(90_000);
  // Run-scoped wipe lives in globalSetup (clean-ux-tour-shots.ts).
  await mkdir(shotDir, { recursive: true });

  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-ux-firstrun-e2e-'));
  await writeFile(
    join(gezelHome, 'config.json'),
    JSON.stringify({
      provider: 'llama-cpp',
      defaultModel: { 'llama-cpp': 'gemma4-e4b-q4' },
    }),
  );

  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_EMBEDDED: '1',
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible({ timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.setContentSize(1440, 900);
  });
});

test.afterAll(async () => {
  await closeApp(app);
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('01 - first boot lands on setup: the download CTA waits for a click', async () => {
  test.setTimeout(90_000);
  // The needs-download banner is the first thing setup shows. Nothing may
  // download without the click this test deliberately never performs.
  // Timeout headroom: HomeView holds a loading splash until the provider
  // probe settles, with a 30s anti-strand fallback — the assertion must
  // outlive that guard, not race it.
  await expect(page.getByText('Set up your first on-device model')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('button', { name: /Download recommended model/ })).toBeVisible();
  await shot('01-first-run-home.png');
});

test('02 - the sidebar frames onboarding as "Get started"', async () => {
  await expect(page.locator('[data-testid="app-sidebar"]')).toContainText('Get started', {
    timeout: 20_000,
  });
  await shot('02-first-run-sidebar.png');
});

test('03 - the tutorial column rides beside setup with the article embedded', async () => {
  // The "what is gezel" tutorial lives in a second column (stacking beneath
  // setup on narrow windows) as the live Handboek embed — player on top,
  // readable article beneath — never behind navigation.
  const tutorial = page.locator('.home-firstrun-tutorial');
  await expect(tutorial).toBeVisible({ timeout: 20_000 });
  await expect(tutorial.getByTestId('home-intro-article')).toBeVisible({ timeout: 20_000 });
  await expect(tutorial.getByRole('button', { name: /Open in Handboek/ })).toBeVisible();
  await tutorial.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot('03-first-run-intro.png');
});

test('04 - first-run in dark mode', async () => {
  // Test 03 scrolled to the intro; bring the download CTA back on screen so
  // the dark capture shows the page's primary action.
  await page.getByRole('button', { name: /Download recommended model/ }).scrollIntoViewIfNeeded();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(600);
  await shot('04-first-run-dark.png');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
});
