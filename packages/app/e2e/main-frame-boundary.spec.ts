import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { waitForAppReady } from './helpers/app-ready.js';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_LOAD_TIMEOUT_MS = 60_000;

/**
 * The preload hands the main window's document the bearer token and the IPC
 * bridge. A gezel once wrote a page, learned its `/preview/` URL from
 * page-check, and put a relative link to it in chat; one click made that page
 * the main frame, holding the token. The main frame may only ever hold the
 * app, and IPC answers only the app.
 */
test.describe('main window holds only the app', () => {
  let home: string;
  let app: ElectronApplication;
  let page: Page;
  let previewUrl: string;

  test.beforeAll(async () => {
    test.setTimeout(UI_LOAD_TIMEOUT_MS + 30_000);
    home = await mkdtemp(join(tmpdir(), 'gezel-main-frame-'));
    app = await electron.launch({
      args: [appRoot],
      env: buildLaunchEnv({
        GEZEL_HOME: home,
        GEZEL_MOCK_PROVIDER: '1',
        GEZEL_EMBEDDED: '1',
        GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
      }),
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await waitForAppReady(page);

    const workspace = join(home, 'projects', 'default', 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, 'takeover.html'),
      '<!doctype html><title>preview</title><script>document.title = "OWNED:" + String(window.__GEZEL__ && window.__GEZEL__.token);</script>',
      'utf8',
    );
    previewUrl = await page.evaluate(async () => {
      const gezel = window.__GEZEL__!;
      const response = await fetch(
        new URL('/api/projects/default/preview-capability', gezel.baseUrl),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${gezel.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ source: 'workspace', path: 'takeover.html' }),
        },
      );
      return ((await response.json()) as { url: string }).url;
    });
    expect(previewUrl).toMatch(/^\/preview\//);
  });

  test.afterAll(async () => {
    await closeApp(app);
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  test("still gives the app its token and answers the app's own IPC", async () => {
    expect(await page.evaluate(() => Boolean(window.__GEZEL__?.token))).toBe(true);
    await expect(page.evaluate(() => window.__GEZEL__!.update!.state())).resolves.toBeDefined();
  });

  test('refuses to load a preview page as the main document', async () => {
    const appUrl = page.url();
    for (const target of [previewUrl, previewUrl.replace('/preview/', '/%70review/')]) {
      await page.evaluate((url) => {
        location.href = url;
      }, target);
      await page.waitForTimeout(1_000);
      expect(page.url(), target).toBe(appUrl);
    }

    // A link in a message, clicked: the shape the attack took.
    await page.evaluate((url) => {
      const link = document.createElement('a');
      link.id = 'takeover-link';
      link.href = url;
      link.textContent = 'Open the interactive report';
      document.body.append(link);
    }, previewUrl);
    // Clicked from the page: Playwright's own click would wait forever for a
    // navigation the guard cancels, since a cancelled one never commits.
    await page.evaluate(() => (document.querySelector('#takeover-link') as HTMLElement).click());
    await page.waitForTimeout(1_000);

    expect(page.url()).toBe(appUrl);
    expect(await page.title()).not.toMatch(/^OWNED:/);
    expect(await page.evaluate(() => Boolean(window.__GEZEL__?.token))).toBe(true);
    await page.evaluate(() => document.querySelector('#takeover-link')?.remove());
  });
});
