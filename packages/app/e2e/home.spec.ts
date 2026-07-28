import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Home Workshop E2E — once a provider is configured (here, the mock
 * provider on a fresh GEZEL_HOME), the Home tab renders the refreshed
 * "workshop": a greeting band and the full-width meester conversation.
 * Captures a full-page screenshot for visual review against the design handoff.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-home-e2e-'));
  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
});

test.afterAll(async () => {
  await app?.close();
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('Home renders the workshop once configured', async () => {
  // The app opens on Home; the workshop appears after the provider probe
  // resolves ok (mock provider) and the meester is auto-provisioned. Use a
  // generous timeout — provisioning + probe race the 2500ms beforeAll wait.
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 20000 });

  // Greeting band (time-of-day headline, no stored user name).
  await expect(page.getByText(/Good (morning|afternoon|evening)\./)).toBeVisible();

  // The meester conversation fills the workshop body; there is no side rail.
  await expect(page.locator('.home-workshop-conversation')).toBeVisible();
  await expect(page.locator('.home-workshop-rail')).toHaveCount(0);
  await expect(page.getByText('On your bench')).toHaveCount(0);
  await expect(page.getByText('The crew today')).toHaveCount(0);
  await expect(page.getByText(/^Jobs in /)).toHaveCount(0);

  // The workshop fits the window (no page-tall growth) and the composer is
  // reachable without scrolling — the conversation scrolls internally.
  const fits = await page.evaluate(() => {
    const ws = document.querySelector('.home-workshop');
    return ws ? ws.getBoundingClientRect().height <= window.innerHeight + 1 : false;
  });
  expect(fits).toBe(true);
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();

  await page.screenshot({
    path: join(screenshotDir, 'home-01-workshop.png'),
    fullPage: true,
  });
});

test('the greeting collapses and the tour tab swaps content', async () => {
  // Collapse → the tip/figure hide; a single status row remains.
  await page.getByRole('button', { name: 'Collapse the greeting' }).click();
  await expect(page.getByText('Tip of the day')).toBeHidden();
  await page.getByRole('button', { name: 'Expand the greeting' }).click();
  await expect(page.getByText('Tip of the day')).toBeVisible();

  // The tour tab swaps the greeting + tip for the tour content in place.
  const tour = page.getByRole('tab', { name: 'New here? What is gezel' });
  await tour.click();
  await expect(tour).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Tip of the day')).toBeHidden();
  await expect(page.getByRole('button', { name: /Open in Handboek/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Read' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Watch' })).toBeVisible();
  await expect(page.getByText(/off-disk/i)).toHaveCount(0);

  await page.screenshot({
    path: join(screenshotDir, 'home-03-workshop-tour.png'),
    fullPage: true,
  });
});

test('renders the workshop in dark (dusk) mode', async () => {
  // Return to the greeting tab left inactive by the previous test (the
  // date tab is always the first in the strip) for a clean shot.
  if (
    await page
      .getByRole('button', { name: /Open in Handboek/ })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole('tab').first().click();
  }

  // Flip the app's explicit-dark trigger ([data-theme="dark"] on <html>),
  // exercising the `.home-workshop` dusk token override.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await expect(page.getByTestId('home-workshop')).toBeVisible();

  // The scoped dusk override must actually win: --paper flips from the day
  // value (#f4ecdc) to the dusk value (#1f1c18) on the workshop root.
  const paper = await page.evaluate(() => {
    const el = document.querySelector('.home-workshop');
    return el ? getComputedStyle(el).getPropertyValue('--paper').trim() : '';
  });
  expect(paper).toBe('#1f1c18');

  await page.screenshot({
    path: join(screenshotDir, 'home-02-workshop-dark.png'),
    fullPage: true,
  });
});
