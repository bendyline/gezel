import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initialPoppetjeForGezel } from '@bendyline/gezel/poppetje';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

test('local Home matches the live chrome and preserves reading across service navigation', async () => {
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
      meester: { id: 'vanya', name: 'Vanya', poppetje: initialPoppetjeForGezel('vanya', 'Vanya') },
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
  // Older versions allowed typing here; carry any pending draft forward even
  // though the startup composer is deliberately gone.
  await mkdir(join(home, 'desktop'), { recursive: true });
  const scope = createHash('sha256').update('local').digest('hex').slice(0, 20);
  await writeFile(
    join(home, 'desktop', `startup-${scope}.json`),
    JSON.stringify({ draft: 'Keep this startup draft exactly.\nA second line.' }),
  );
  const app = await electron.launch({
    args: [resolve('.')],
    env: buildLaunchEnv({
      GEZEL_HOME: home,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
      GEZEL_E2E_STARTUP_DELAY_MS: '15000',
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
    await expect(page.locator('.home-workshop-figure svg')).toBeVisible();
    await expect(page.locator('.startup-home textarea, .startup-search')).toHaveCount(0);
    await expect(page.locator('.startup-sidebar .app-sidebar-item')).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready);
    const chrome = async () =>
      page.evaluate(() =>
        Object.fromEntries(
          ['.app-header-brand', '.app-nav-home-logotype', '.app-sidebar-home'].map((selector) => {
            const element = document.querySelector(selector)!;
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return [
              selector,
              {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                font: style.fontFamily,
                background: style.backgroundColor,
                border: style.borderRadius,
              },
            ];
          }),
        ),
      );
    const startupChrome = await chrome();
    const pillMetrics = () =>
      page
        .locator('.activity-control')
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            y: box.y,
            height: box.height,
            font: style.fontFamily,
            size: style.fontSize,
            lineHeight: style.lineHeight,
            border: style.border,
            radius: style.borderRadius,
            padding: style.padding,
            background: style.backgroundColor,
          };
        });
    const startupPill = await pillMetrics();
    await page.screenshot({ path: join(screenshots, 'startup-home-local.png') });
    await page.getByRole('tab', { name: 'Night shift', exact: true }).click();
    await expect(page.getByText('The research notes are ready for your review.')).toBeVisible();

    await page.getByRole('tab', { name: 'Handboek', exact: true }).click();
    await expect(page.locator('.home-intro-doc .squisq-linear')).toBeVisible();
    await expect(page.locator('#startup-reading img[alt="gezel-mark"]')).toHaveCount(1);
    await page.locator('#startup-reading .home-intro-doc').evaluate(async (node) => {
      await Promise.all(Array.from(node.querySelectorAll('img'), (image) => image.decode()));
      await document.fonts.ready;
    });
    await page.locator('#startup-reading .home-intro-doc').evaluate((node) => {
      node.scrollTop = 240;
    });
    const readerMetrics = (host: string) =>
      page.locator(host).evaluate((node) =>
        Object.fromEntries(
          ['.home-intro-doc', '.squisq-page-prose', '.squisq-page-prose h2'].map((selector) => {
            const element = node.querySelector(selector)!;
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return [
              selector,
              {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                font: style.fontFamily,
                size: style.fontSize,
                lineHeight: style.lineHeight,
                color: style.color,
                background: style.backgroundColor,
              },
            ];
          }),
        ),
      );
    const startupReader = await readerMetrics('#startup-reading');
    await page.screenshot({ path: join(screenshots, 'startup-home-reading.png') });
    await expect(page).toHaveURL(/^https?:\/\//, { timeout: 60_000 });
    await expect(page.locator('#startup-home')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.startup-reading-live')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Handboek', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      await page
        .locator('.startup-reading-live .home-intro-doc')
        .evaluate((node) => node.scrollTop),
    ).toBeGreaterThan(150);
    expect(await chrome()).toEqual(startupChrome);
    expect(await pillMetrics()).toEqual(startupPill);
    expect(await readerMetrics('.startup-reading-live')).toEqual(startupReader);
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
