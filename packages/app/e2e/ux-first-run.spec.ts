import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * First-run onboarding tour — what a brand-new user sees on their first
 * boot, before any provider works: the meester's welcome. Asserts the
 * load-bearing pieces of the flow and captures screenshots into
 * `screenshots/ux-tour/first-run/` for UX review (the warm-state twin is
 * `ux-tour.spec.ts`).
 *
 * The packaged first boot pins `config.provider` to the on-device engine
 * with a recommended model (`bootstrapOnDeviceFirstRun`), then waits for the
 * person's tap before downloading anything. Tests skip that bootstrap
 * (GEZEL_SKIP_SYSTEM_BOOTSTRAP), so this spec seeds the same pin into
 * config.json by hand. The "Fetch my tools" key it produces is inert until
 * pressed, which this spec never does, so nothing multi-GB happens.
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
      // This is the true first run, first-use hold and all.
      GEZEL_DISABLE_FIRST_USE_GRACE: '',
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

test('01 - first boot opens on the meester, who asks for their tools with one key', async () => {
  test.setTimeout(90_000);
  // Timeout headroom: HomeView holds a loading splash until the provider
  // probe settles, with a 30s anti-strand fallback — the assertion must
  // outlive that guard, not race it.
  const welcome = page.getByTestId('meester-welcome');
  await expect(welcome).toHaveAttribute('data-welcome-state', 'needs-download', {
    timeout: 60_000,
  });
  await expect(welcome.getByRole('heading', { name: /I run this workshop/ })).toBeVisible();
  await expect(welcome.getByRole('button', { name: /^Fetch my tools/ })).toBeVisible();
  // One surface: no setup form, no posture tray, no preference switches.
  await expect(page.getByText('First run setup')).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Security posture' })).toHaveCount(0);
  await expect(welcome.getByRole('checkbox')).toHaveCount(0);
  await shot('01-first-run-home.png');
});

test('02 - the sidebar frames onboarding as "Get started"', async () => {
  await expect(page.locator('[data-testid="app-sidebar"]')).toContainText('Get started', {
    timeout: 20_000,
  });
  await shot('02-first-run-sidebar.png');
});

test('03 - the title bar stays quiet until the workshop is running', async () => {
  const header = page.getByTestId('app-header');
  await expect(header.getByTestId('engine-pill')).toHaveCount(0);
  await expect(header.getByRole('button', { name: /^Task speed:/ })).toHaveCount(0);
  await expect(header.getByRole('button', { name: /^Activity/ })).toHaveCount(0);
});

test('04 - the tour opens in place, without leaving the welcome', async () => {
  const welcome = page.getByTestId('meester-welcome');
  // A new install is asked what it wants help with first, and the question
  // holds the tour's place until it is answered or set aside.
  await expect(welcome.getByRole('group', { name: 'What you would like help with' })).toBeVisible();
  await welcome.getByRole('button', { name: 'Not now' }).click();
  await welcome.getByRole('button', { name: 'Take the 1-minute tour' }).click();
  await expect(welcome.getByTestId('home-intro-article')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await shot('03-first-run-intro.png');
  await welcome.getByRole('button', { name: 'Hide the tour' }).click();
});

test('05 - first-run in dark mode', async () => {
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(600);
  await shot('04-first-run-dark.png');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
});
