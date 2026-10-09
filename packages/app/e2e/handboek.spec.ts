import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));

let app: ElectronApplication;
let page: Page;
let gezelHome: string;

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-e2e-handboek-'));

  app = await electron.launch({
    args: [join(_dirname, '..')],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_EMBEDDED: '1',
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    }),
  });

  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('bundled Handboek opens in Knowledge with its articles and images', async () => {
  const link = page.getByTestId('sidebar-area-knowledge');
  await link.waitFor({ state: 'visible', timeout: 20_000 });
  await link.click();

  const view = page.getByTestId('knowledge-view');
  await expect(view).toBeVisible();

  // Topics and the auto-opened welcome article come from the .gezk.
  await expect(view.locator('.knowledge-doc-row').first()).toBeVisible();
  await expect(view.locator('.knowledge-reader-body')).toBeVisible({ timeout: 15_000 });
  await expect(view.locator('.knowledge-reader-header h2')).toBeVisible();

  // The brand image paints from the UI bundle (`inlineBundledAssets`), so the
  // first paint never requests a path no route serves. knowledge.spec covers
  // the catalog asset route's blob: images.
  await page.waitForFunction(
    () => {
      const imgs = Array.from(document.querySelectorAll('.knowledge-reader-body img'));
      return imgs.some(
        (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  const row = view.locator('.knowledge-doc-row:not([aria-current="true"])').first();
  const title = (await row.locator('.knowledge-doc-title').innerText()).trim();
  const previousBody = await view.locator('.knowledge-reader-body').innerText();
  await row.click();
  await expect(view.locator('.knowledge-reader-header h2')).toHaveText(title);
  await expect(view.locator('.knowledge-reader-body')).not.toHaveText(previousBody);
});
