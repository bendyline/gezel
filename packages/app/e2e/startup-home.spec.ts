import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

test('local Home preserves reading and a draft across the real service navigation', async () => {
  test.setTimeout(120_000);
  const home = await mkdtemp(join(tmpdir(), 'gezel-startup-e2e-'));
  const screenshots = resolve('screenshots');
  await mkdir(screenshots, { recursive: true });
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({ nightShift: { enabled: false }, themePref: 'dark' }),
  );
  await writeFile(
    join(home, 'startup-home.json'),
    JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      theme: 'dark',
      sidebar: 'right',
      meester: { id: 'vanya', name: 'Vanya' },
      status: {
        headline: 'The workshop is in good shape',
        content: 'Your crew finished the research notes. There is a report ready for you to read.',
        at: new Date().toISOString(),
      },
      lastMessage: {
        content: 'Please look over the research and leave me a short report.',
        at: new Date().toISOString(),
      },
      night: {
        windowEnd: new Date().toISOString(),
        completed: 2,
        reports: [
          {
            title: 'Notes from the night shift',
            project: 'Research',
            content:
              '# A quiet night in the workshop\n\nThe research notes are ready for your review.',
          },
        ],
      },
    }),
  );
  const app = await electron.launch({
    args: [resolve('.')],
    env: buildLaunchEnv({
      GEZEL_HOME: home,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
      GEZEL_E2E_STARTUP_DELAY_MS: '8000',
    }),
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#startup-home')).toBeVisible();
    expect(page.url()).toContain('/startup/index.html');
    await expect(page.getByText('The workshop is in good shape')).toBeVisible();
    const native = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      return {
        resizable: win.isResizable(),
        minimizable: win.isMinimizable(),
        maximizable: win.isMaximizable(),
      };
    });
    expect(native).toEqual({ resizable: true, minimizable: true, maximizable: true });
    await page.screenshot({ path: join(screenshots, 'startup-home-local.png') });
    await page.getByRole('tab', { name: 'Night shift', exact: true }).click();
    await expect(page.getByText('The research notes are ready for your review.')).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Message to your meester' })
      .fill('Keep this startup draft exactly.\nA second line.');
    await page.getByRole('tab', { name: 'Handboek', exact: true }).click();
    await page.locator('.startup-article-picker button').last().click();
    await page.locator('#startup-reading').evaluate((node) => {
      node.scrollTop = 240;
    });
    await page.screenshot({ path: join(screenshots, 'startup-home-reading.png') });
    await expect(page).toHaveURL(/^https?:\/\//, { timeout: 60_000 });
    await expect(page.locator('#startup-home')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.startup-reading-live')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Handboek', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      await page.locator('.startup-reading-live').evaluate((node) => node.scrollTop),
    ).toBeGreaterThan(150);
    await page.screenshot({ path: join(screenshots, 'startup-home-live.png') });
    await page.getByRole('button', { name: 'Return to Meester chat', exact: true }).click();
    await expect(
      page.locator('[data-testid="meester-chat"] [contenteditable="true"]').first(),
    ).toContainText('Keep this startup draft exactly.');
    const cacheFiles = await readdir(join(home, 'desktop'));
    await expect
      .poll(
        async () => JSON.parse(await readFile(join(home, 'desktop', cacheFiles[0]!), 'utf8')).draft,
      )
      .toBe('');
  } finally {
    await closeApp(app);
    await rm(home, { recursive: true, force: true });
  }
});
