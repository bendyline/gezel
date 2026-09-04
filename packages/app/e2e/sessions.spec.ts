import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveThreadTitle } from '@bendyline/gezel';
/**
 * Sessions E2E — exercises the session picker, send-and-reply, restart
 * persistence, and "new session" flows on the Meester chat surface that
 * lives on the Home view. Uses GEZEL_MOCK_PROVIDER=1 so it runs without
 * real credentials.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';
import { captureScreenshot } from './helpers/screenshot.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');

let gezelHome: string;

/**
 * One message, typed as two lines. The line break is the point: Enter
 * opens a new line in the chat composer and Shift+Enter is what sends,
 * so a draft that survives the first keypress proves the split.
 */
const FIRST_LINE = 'hello from e2e';
const SECOND_LINE = 'still drafting';

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-sessions-e2e-'));
});

test.afterAll(async () => {
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
      // Session persistence is the behavior under test. Do not make app
      // shutdown wait for unrelated post-turn memory extraction.
      GEZEL_DISABLE_MEMORY_EXTRACTION: '1',
    }),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Home is the default view and is where the Meester chat lives — click
  // the brand mark anyway so the test works even if we later default
  // elsewhere.
  const brand = page.locator('.app-header-brand');
  await expect(brand).toBeVisible({ timeout: 20_000 });
  await brand.click();
  await expect(page.locator('.squisq-wysiwyg-editor').first()).toBeVisible({ timeout: 20_000 });
  return { app, page };
}

test('sessions — send a message, it persists, shows up after restart', async () => {
  // This is the only E2E that deliberately performs two complete Electron
  // lifecycles in one test. Keep a lifecycle-sized budget for slow CI hosts;
  // retries are disabled suite-wide, so a genuine timeout remains visible.
  test.setTimeout(150_000);

  // First launch: send a message to the auto-provisioned Meester, close.
  {
    const { app, page } = await launch();
    try {
      await captureScreenshot(page, {
        path: join(screenshotDir, 'sessions-01-chat-opened.png'),
        fullPage: true,
      });

      // Type into the composer. Squisq renders a contenteditable div;
      // focus it and type.
      const editor = page.locator('.squisq-wysiwyg-editor').first();
      await editor.click();
      await page.keyboard.type(FIRST_LINE);
      // Enter is a new line, not a send. Proving that needs the real
      // editor: jsdom cannot tell a paragraph break from a swallowed key.
      await page.keyboard.press('Enter');
      await page.keyboard.type(SECOND_LINE);
      await expect(page.locator('.msg-user')).toHaveCount(0);
      await captureScreenshot(page, {
        path: join(screenshotDir, 'sessions-02-typed.png'),
        fullPage: true,
      });

      // Send is Shift+Enter; a bare Enter is a new line in the draft.
      await page.keyboard.press('Shift+Enter');

      // Auto-recall may prepend indexed context to the provider prompt, so
      // assert within an assistant bubble rather than requiring the user text
      // to follow "Mock reply:" immediately (or matching the user's bubble).
      const reply = page
        .locator('.msg-from-gezel, .msg-assistant')
        .filter({ hasText: 'Mock reply:' })
        .filter({ hasText: FIRST_LINE })
        .filter({ hasText: SECOND_LINE })
        .last();
      await expect(reply).toBeVisible({ timeout: 90_000 });
      await captureScreenshot(page, {
        path: join(screenshotDir, 'sessions-03-reply.png'),
        fullPage: true,
      });
    } finally {
      await closeApp(app);
    }
  }

  // Second launch with the same GEZEL_HOME — session should restore.
  {
    const { app, page } = await launch();
    try {
      // Auto-opens the most recent session; wait for its persisted reply to
      // render instead of assuming a fixed restart delay is enough.
      const persistedReply = page
        .locator('.msg-from-gezel, .msg-assistant')
        .filter({ hasText: 'Mock reply:' })
        .filter({ hasText: FIRST_LINE })
        .last();
      await expect(persistedReply).toBeVisible({ timeout: 15_000 });
      await captureScreenshot(page, {
        path: join(screenshotDir, 'sessions-04-restarted.png'),
        fullPage: true,
      });

      // Session dropdown auto-opens the most recent. The service compacts the
      // starter into a deterministic thread title instead of retaining the
      // raw prompt, so use that shared algorithm for the integration check.
      const sessionTrigger = page.locator('.gezel-chat-session-select').first();
      await expect(sessionTrigger.locator('.session-row-title')).toHaveText(
        deriveThreadTitle(`${FIRST_LINE}\n${SECOND_LINE}`),
        { timeout: 10_000 },
      );
    } finally {
      await closeApp(app);
    }
  }
});

test('sessions — + New session starts a fresh thread', async () => {
  const { app, page } = await launch();
  try {
    // Snapshot the current session trigger text so we can confirm it changes.
    const sessionTrigger = page.locator('.gezel-chat-session-select').first();
    const before = (await sessionTrigger.textContent()) ?? '';

    // Scope the click to the SessionSwitcher's own button — other views
    // expose "+ New …" labels (gezel/project/task creators), and a more
    // specific locator is more robust against future tab additions.
    await page.locator('.gezel-chat-session-btn', { hasText: '+ New' }).click();
    await expect(sessionTrigger).not.toHaveText(before, { timeout: 10_000 });
    await captureScreenshot(page, {
      path: join(screenshotDir, 'sessions-05-new-session.png'),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
  }
});
