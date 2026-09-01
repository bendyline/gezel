import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
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

test('sidebar selection persists and document icons align with their group header', async () => {
  const gezelHome = await mkdtemp(join(tmpdir(), 'gezel-sidebar-e2e-'));
  await mkdir(join(gezelHome, 'documents'), { recursive: true });
  await writeFile(join(gezelHome, 'documents', 'alignment-check.md'), '# Alignment check\n');
  const app = await launch(gezelHome);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Wait for the App (and its `gezel:open-tab` listener) to mount. The
    // sidebar rendering is the proxy for "App.tsx finished first render".
    await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible({ timeout: 10_000 });

    await test.step('document icons align with the Documents header', async () => {
      const documentsToggle = page.getByTestId('sidebar-group-toggle-documents');
      if ((await documentsToggle.getAttribute('aria-expanded')) !== 'true') {
        await documentsToggle.click();
      }
      await expect(documentsToggle).toHaveAttribute('aria-expanded', 'true');

      const documentsHeaderIcon = page.locator(
        '[data-testid="sidebar-group-documents"] .app-sidebar-item-icon',
      );
      const documentRowIcon = page
        .getByRole('button', { name: 'alignment-check', exact: true })
        .locator('.tree-icon');
      await expect(documentRowIcon).toBeVisible({ timeout: 10_000 });

      // Both lists load asynchronously during startup. Poll the measured
      // centers so the assertion observes the settled sidebar layout rather
      // than a single frame while its rows are being inserted.
      await expect
        .poll(
          async () => {
            const [headerBox, rowBox] = await Promise.all([
              documentsHeaderIcon.boundingBox(),
              documentRowIcon.boundingBox(),
            ]);
            if (!headerBox || !rowBox) return Number.POSITIVE_INFINITY;
            const headerCenter = headerBox.x + headerBox.width / 2;
            const rowCenter = rowBox.x + rowBox.width / 2;
            return Math.abs(rowCenter - headerCenter);
          },
          { timeout: 10_000 },
        )
        .toBeLessThan(0.5);
    });

    // Navigate by the canonical event the listing views / chat surfaces
    // dispatch. This drives `selection` → TabContent renders the area.
    // A group header reads as "active" only when its full area screen is
    // open ({ kind: 'area' }), not when an individual item of that kind is
    // selected — so open the Projects area screen here.
    await test.step('project-area selection is active and persisted', async () => {
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent('gezel:open-tab', {
            detail: { kind: 'area', area: 'projects' },
          }),
        );
      });

      // Assert the intended group, not merely that some group is active.
      await expect(
        page.locator('[data-group="projects"] > .app-sidebar-group-header'),
      ).toHaveClass(/\bactive\b/, { timeout: 10_000 });

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
    });
  } finally {
    await closeApp(app);
    await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
  }
});
