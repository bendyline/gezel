import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Security & Compliance UX driver — exercises the new centralized
 * security policy surfaces:
 *   1. First-run "Security & compliance" level step on the Home tab
 *      (shown before provider setup on a fresh, unconfigured install).
 *   2. The Settings → Security & Compliance panel (level slider +
 *      per-capability toggles, with the level snapping to "Custom").
 *
 * Captures screenshots for visual review at each step.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
}

test.describe('Security & Compliance — first run', () => {
  let home: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-sec-firstrun-'));
    // Pre-seed config so the on-device first-run bootstrap skips its
    // model auto-download (firstRunCompleted), and pin `provider` to
    // openai with no API key. That keeps the app deterministically
    // unconfigured: openai needs a credential, so the Home view's
    // auto-probe never fires (it only probes copilot/ollama or a
    // provider that already has creds). Leaving `provider` unset would
    // default to copilot, whose probe *succeeds* on any host that has
    // GitHub Copilot auth — flipping the app to "configured" and
    // rendering the workshop instead of the first-run Intro → Security →
    // Setup flow this spec exercises.
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ firstRunCompleted: true, provider: 'openai' }),
      'utf8',
    );
    app = await electron.launch({
      args: [appRoot],
      env: buildLaunchEnv({
        GEZEL_HOME: home,
        GEZEL_EMBEDDED: '1',
        // Force the file-backed secret store rooted in this throwaway
        // GEZEL_HOME. Without it the service reads the real OS keychain,
        // which is shared across every home — so a developer's actual
        // OpenAI key makes `hasOpenaiApiKey` true, the auto-probe fires
        // and succeeds, and the app renders the configured workshop
        // instead of the first-run flow. The fresh home has no secrets,
        // keeping the app genuinely unconfigured.
        GEZEL_SECRETS_BACKEND: 'file',
      }),
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
  });

  test.afterAll(async () => {
    // Switching security posture can leave first-run background work to
    // drain during embedded-service shutdown. Preserve graceful cleanup,
    // but give this Electron-specific hook more room than a UI assertion.
    test.setTimeout(60_000);
    await app?.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  test('first-run shows the security level step with pills', async () => {
    // The section heading is "Security & compliance" (sentence case in
    // the first-run framing).
    const heading = page.getByRole('heading', { name: /Security & compliance/i });
    await expect(heading).toBeVisible({ timeout: 20000 });

    // All three level pills are present. Anchor the match — "Lockdown"
    // is a substring of "Super Lockdown", so an unanchored regex is
    // ambiguous under Playwright strict mode.
    for (const label of ['Super Lockdown', 'Lockdown', 'Unrestricted']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
    }
    await shot(page, 'sec-01-firstrun.png');

    // Pick Super Lockdown → it becomes active and the blurb updates.
    await page.getByRole('button', { name: /^Super Lockdown/ }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText(/Nothing leaves your machine/i)).toBeVisible();
    await shot(page, 'sec-02-firstrun-super-lockdown.png');
  });
});

test.describe('Security & Compliance — settings panel', () => {
  let home: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-sec-settings-'));
    app = await electron.launch({
      args: [appRoot],
      // Mock provider → configured, full shell with sidebar + settings.
      env: buildLaunchEnv({
        GEZEL_HOME: home,
        GEZEL_MOCK_PROVIDER: '1',
        GEZEL_EMBEDDED: '1',
      }),
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
  });

  test.afterAll(async () => {
    await app?.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  test('panel shows slider + toggles and snaps to Custom', async () => {
    // Open the Settings area from the sidebar.
    await page.getByTestId('sidebar-area-settings').click();
    await page.waitForTimeout(800);

    // Click the "Security & Compliance" nav item in the settings sidebar.
    await page.getByRole('button', { name: 'Security & Compliance' }).click();
    await page.waitForTimeout(600);

    // Panel heading + the three level pills + the five capability toggles.
    await expect(page.getByRole('heading', { name: /Security & Compliance/i })).toBeVisible({
      timeout: 10000,
    });
    for (const label of ['Super Lockdown', 'Lockdown', 'Unrestricted']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
    }
    await expect(page.getByText('Edit files', { exact: true })).toBeVisible();
    await expect(page.getByText('External chat providers', { exact: true })).toBeVisible();
    await expect(page.getByText('Execute scripts', { exact: true })).toBeVisible();
    await shot(page, 'sec-03-settings-panel.png');

    // Select Lockdown preset, then flip a single toggle → level "Custom".
    await page.getByRole('button', { name: /^Lockdown/ }).click();
    await page.waitForTimeout(500);
    await shot(page, 'sec-04-settings-lockdown.png');

    // Toggle "Edit files" off-preset from Lockdown (edits on) → Custom.
    // Target the checkbox inside its label (plain getByText matches both
    // the label and its inner <strong> under strict mode).
    const editFiles = page
      .locator('label.debug-toggle', { hasText: 'Edit files' })
      .getByRole('checkbox');
    await editFiles.click();
    await page.waitForTimeout(600);
    await expect(page.getByRole('button', { name: /^Custom/ })).toBeVisible({ timeout: 5000 });
    await shot(page, 'sec-05-settings-custom.png');
  });
});
