import { readFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { writePageDemo, writePageDemoAssets } from '../../cli/src/page-demo-export.js';

import { catalogPages } from './helpers/catalog-apps.js';
const gilde = process.env.GILDE_DIR;
for (const app of catalogPages()) {
  test(`${app.id}: fullscreen, working page actions, both themes, and narrow layout`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const source = join(app.dir, 'pages');
    const files = readdirSync(source, { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile())
      .map((file) => {
        const absolute = join(file.parentPath, file.name);
        return {
          path: absolute.slice(source.length + 1).replaceAll('\\', '/'),
          bytes: readFileSync(absolute),
        };
      });
    const manifest = JSON.parse(await readFile(join(app.dir, 'manifest.json'), 'utf8'));
    const output = info.outputPath('demo');
    const shared = join(output, '_shared');
    await writePageDemo(
      output,
      files,
      { imports: manifest.pages.imports },
      {
        directory: shared,
        assets: await writePageDemoAssets(shared),
      },
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(pathToFileURL(join(output, app.entry)).href);
    await expect(page.locator('gezel-app-layout')).toHaveCount(1);
    await expect(page.locator('[data-gezel-demo-banner]')).toBeVisible();
    // A demo is the whole window: it opens in the app layout without the Fullscreen API.
    await expect(page.locator('html')).toHaveAttribute('data-gezel-fullscreen', 'true');
    if (app.id !== 'media-library') {
      await expect(page.getByRole('button', { name: 'Hide conversation' })).toBeVisible();
      const chat = page.locator('gezel-chat');
      await expect(chat.locator('.msg.gezel').first()).toBeVisible();
      const idea = chat.getByRole('group', { name: 'Try asking' }).getByRole('button').first();
      if (await idea.isVisible()) {
        await idea.click();
        await expect(chat.locator('.msg.you')).toHaveCount(1);
        await expect(chat.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({
          timeout: 15_000,
        });
        await expect(chat.locator('.msg.gezel')).not.toHaveCount(1);
        await expect(chat.locator('.step.failed')).toHaveCount(0);
      }
      await page.getByRole('button', { name: 'Hide conversation' }).click();
      await expect(page.getByRole('button', { name: 'Show conversation' })).toBeVisible();
      await page.getByRole('button', { name: 'Show conversation' }).click();
    }
    const forms = page.locator('gezel-action-form');
    for (let i = 0; i < (await forms.count()); i++) {
      const form = forms.nth(i);
      await form.locator('summary').click();
      const controls = form.locator('input, select, textarea');
      for (let j = 0; j < (await controls.count()); j++) {
        const control = controls.nth(j);
        if (!(await control.isVisible())) continue;
        const tag = await control.evaluate((e) => e.tagName);
        const type = await control.getAttribute('type');
        const name = await control.getAttribute('name');
        if (tag === 'SELECT') {
          await expect(control.locator('option')).not.toHaveCount(0);
          const value = await control.locator('option').last().getAttribute('value');
          await control.selectOption(value!);
        } else {
          await control.fill(
            type === 'number'
              ? '7'
              : type === 'date'
                ? '2026-11-20'
                : type === 'url'
                  ? 'https://example.com/job'
                  : name === 'donor'
                    ? 'Mara'
                    : name === 'colors'
                      ? '#27352D, #557A5B, #FAF7F2'
                      : 'A useful test note',
          );
        }
      }
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(form.getByRole('status')).toHaveText('Saved.');
      await form.locator('summary').click();
    }
    const searches = page.locator('gezel-collection-filter input');
    for (let i = 0; i < (await searches.count()); i++) {
      if (!(await searches.nth(i).isVisible())) continue;
      await searches.nth(i).fill('no such record xyz');
      await searches.nth(i).fill('');
    }
    if (app.id === 'language-trainer') {
      await page.getByRole('button', { name: 'Ordering at a café', exact: false }).click();
      await expect(page.locator('#scene-section')).toBeVisible();
      await page.getByRole('button', { name: 'End scene', exact: true }).click();
      await expect(page.locator('#scene-section')).toBeHidden();
      await page.getByRole('tab', { name: 'Review & phrasebook' }).click();
      await expect(page.locator('#phrasebook li')).toHaveCount(3);
      await page.getByRole('button', { name: 'Show the answer' }).click();
      await page.getByRole('button', { name: 'Got it', exact: true }).click();
      await expect(page.locator('#due')).toHaveText('1');
      await page.getByRole('tab', { name: 'Your progress' }).click();
      await expect(page.locator('#practice-summary')).toContainText('phrases collected');
      await page.getByRole('tab', { name: 'Practice', exact: true }).click();
    }
    if (app.id === 'image-feed' || app.id === 'social-feed') {
      const cards = page.locator('[data-post]');
      await cards.first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
    }
    await expect(page.locator('#app-load-error')).toBeHidden();
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.screenshot({ path: info.outputPath(`${app.id}-${theme}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
      .toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`${app.id}-narrow.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('catalog checkout is selected', () => {
  test.skip(
    !gilde && !process.env.GEZEL_APP_AUDIT_MANIFEST,
    'Set GILDE_DIR to exercise the public app pages.',
  );
  expect(catalogPages().length).toBeGreaterThan(20);
});
