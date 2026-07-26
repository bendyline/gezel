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
  await app?.close();
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('handboek opens from the sidebar, renders an article, and plays as video', async () => {
  // The sidebar renders the Handboek area link once the app shell is up.
  const link = page.getByTestId('sidebar-area-handboek');
  await link.waitFor({ state: 'visible', timeout: 20_000 });
  await link.click();

  const view = page.getByTestId('handboek-view');
  await expect(view).toBeVisible();

  // TOC areas + the auto-opened first article (welcome).
  await expect(view.getByText('Concepts')).toBeVisible();
  await expect(page.getByTestId('handboek-doc')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 2, name: 'What is gezel?' })).toBeVisible();

  // Open a personalized article — the fresh install auto-creates a
  // Meester, so the crew article names them.
  await view
    .getByRole('button', { name: 'Your crew: gezellen, the Meester, and the Voorman' })
    .click();
  await expect(page.getByText(/Your Meester is/).first()).toBeVisible({ timeout: 15_000 });

  // The Meester's poppetje figure must actually paint — a blob-URL SVG
  // with no xmlns resolves but renders 0×0 (the invisible-poppetjes
  // incident), so assert real intrinsic size, not just presence.
  await page.waitForFunction(
    () => {
      const imgs = Array.from(document.querySelectorAll('.handboek-doc img'));
      return imgs.some(
        (el) =>
          (el as HTMLImageElement).src.startsWith('blob:') &&
          (el as HTMLImageElement).naturalWidth > 0,
      );
    },
    undefined,
    { timeout: 15_000 },
  );

  // Toggle to the video playback mode: the DocPlayer mounts.
  await view.getByRole('radio', { name: 'Video' }).click();
  await expect(page.getByTestId('handboek-player')).toBeVisible();
  await expect(page.getByTestId('handboek-doc')).toHaveCount(0);

  // And back to the document.
  await view.getByRole('radio', { name: 'Document' }).click();
  await expect(page.getByTestId('handboek-doc')).toBeVisible();
});
