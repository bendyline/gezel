import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));

async function launch(gezelHome: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(_dirname, '..')],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_EMBEDDED: '1',
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    }),
  });
}

const SHORTCUT = process.platform === 'darwin' ? 'Meta+p' : 'Control+p';

test.setTimeout(60_000);

test('titlebar search: shortcut focuses the box and typing opens the palette', async () => {
  const gezelHome = await mkdtemp(join(tmpdir(), 'gezel-search-e2e-'));
  const app = await launch(gezelHome);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible({ timeout: 10_000 });

    const input = page.locator('[data-testid="titlebar-search-input"]');
    await expect(input).toBeVisible();

    // ⌘P / Ctrl+P focuses the search box from anywhere in the app.
    await page.keyboard.press(SHORTCUT);
    await expect(input).toBeFocused();

    // Typing runs a debounced unified-search request over HTTP and opens the
    // results palette (with results or a "No results" line either way).
    await input.fill('default');
    await expect(page.locator('[data-testid="search-palette"]')).toBeVisible({ timeout: 10_000 });
  } finally {
    await app.close();
    await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
  }
});
