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
      // Skip the on-device first-run download (Gemma 4 E4B is ~5 GB) so
      // the regular UI loads instead of the install wizard.
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    }),
  });
}

// Electron launch + worker contention can push this past the default
// 30s budget. Bump it.
test.setTimeout(60_000);

test('sidebar selection drives the content pane and persists', async () => {
  const gezelHome = await mkdtemp(join(tmpdir(), 'gezel-sidebar-e2e-'));
  const app = await launch(gezelHome);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Wait for the App (and its `gezel:open-tab` listener) to mount. The
    // sidebar rendering is the proxy for "App.tsx finished first render".
    await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible({ timeout: 10_000 });

    // Navigate by the canonical event the listing views / chat surfaces
    // dispatch. This drives `selection` → TabContent renders the area.
    // A group header reads as "active" only when its full area screen is
    // open ({ kind: 'area' }), not when an individual item of that kind is
    // selected — so open the Projects area screen here.
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('gezel:open-tab', {
          detail: { kind: 'area', area: 'projects' },
        }),
      );
    });

    // The Projects group reflects the active project-area selection.
    await expect(page.locator('.app-sidebar-group-header.active')).toBeVisible({ timeout: 5_000 });

    // Selection persists to localStorage (UI-chrome state). Note: the
    // last view is restored on next boot from this key — we assert the
    // write here rather than across a restart, since Chromium flushes
    // localStorage to disk asynchronously and a quick relaunch races it.
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const raw = window.localStorage.getItem('gezel:nav:selection');
            return raw ? (JSON.parse(raw) as { kind?: string; id?: string }) : null;
          }),
        { timeout: 10_000 },
      )
      .toMatchObject({ kind: 'area', area: 'projects' });
  } finally {
    await app.close();
    await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
  }
});
