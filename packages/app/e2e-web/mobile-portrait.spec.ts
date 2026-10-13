import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures/test.js';
import { setTheme, settle } from './helpers/determinism.js';
import { openAreaView, openGezel, openProject, openTab, openTask } from './helpers/nav.js';

test.use({
  daemonGroup: 'portrait-review',
  hasTouch: true,
  deviceScaleFactor: 1,
  browserName: process.env.GEZEL_PORTRAIT_WEBKIT === '1' ? 'webkit' : 'chromium',
  launchOptions: {},
});

for (const profile of [
  { name: 'small', width: 320, height: 568, ios: false },
  { name: 'iphone', width: 390, height: 844, ios: true },
]) {
  test.describe(profile.name, () => {
    test('portrait tour', async ({ page, world }, testInfo) => {
      test.setTimeout(180_000);
      test.skip(!world, 'requires the seeded world');
      page.setDefaultTimeout(10_000);
      await page.setViewportSize({ width: profile.width, height: profile.height });
      await page.goto('/');
      await expect(page.getByTestId('app-sidebar')).toBeVisible();
      if (profile.ios) {
        await page.addStyleTag({
          content: await readFile(
            new URL('../../mobile/src/product-host.css', import.meta.url),
            'utf8',
          ),
        });
        await page.evaluate(() => {
          document.documentElement.dataset.platform = 'ios';
          document.documentElement.style.fontSize = '19px';
          document.documentElement.style.setProperty('--safe-area-inset-top', '59px');
          document.documentElement.style.setProperty('--safe-area-inset-bottom', '34px');
        });
      }
      const directory = process.env.GEZEL_PORTRAIT_SHOTS ?? testInfo.outputPath('portrait');
      await mkdir(directory, { recursive: true });
      const audit: unknown[] = [];
      const capture = async (name: string) => {
        await page.waitForTimeout(500);
        await settle(page);
        await page.screenshot({ path: join(directory, `${profile.name}-${name}.png`) });
        const overflow = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>('body *'))
            .filter((el) => {
              const box = el.getBoundingClientRect();
              return (
                box.width > 0 &&
                box.height > 0 &&
                el.checkVisibility() &&
                !el.closest('[inert]') &&
                el.scrollWidth > el.clientWidth + 3 &&
                getComputedStyle(el).overflowX === 'visible'
              );
            })
            .map((el) => ({
              tag: el.tagName,
              class: el.className,
              text: el.textContent?.slice(0, 100),
              width: el.clientWidth,
              scroll: el.scrollWidth,
            })),
        );
        const clipped = await page
          .locator(
            '.tasks-header, .task-step-panel-grid, .filemap-header, .settings-panel, .squisq-editor-header',
          )
          .evaluateAll((elements) =>
            elements
              .filter((element) => element.checkVisibility() && !element.closest('[inert]'))
              .filter((element) => element.scrollWidth > element.clientWidth + 1)
              .map((element) => ({
                class: element.className,
                width: element.clientWidth,
                content: element.scrollWidth,
              })),
          );
        expect.soft(clipped, `${profile.name}: ${name} has clipped panel content`).toEqual([]);
        audit.push({ name, overflow });
        await writeFile(
          join(directory, `${profile.name}-audit.json`),
          JSON.stringify(audit, null, 2),
        );
      };
      await capture('navigation');
      await page.getByRole('button', { name: /^Home ·/ }).click();
      await expect(page.getByTestId('home-workshop')).toBeVisible();
      await capture('home');
      await page.getByRole('tab', { name: 'Make something', exact: true }).click();
      await capture('home-starters');
      await page.getByRole('button', { name: 'Return to Meester chat', exact: true }).click();
      await openProject(page, world!.projectId);
      await expect(page.getByTestId('project-tab-chat')).toBeVisible();
      await expect(page.getByTestId('chat-timeline')).toContainText(
        'Mock reply: Hello from the web e2e seed',
      );
      await capture('project-chat');
      const composer = page.getByTestId('chat-composer');
      await composer.locator('[contenteditable="true"]').first().fill('Portrait chat check');
      await composer.locator('.chat-send-btn').click();
      await expect(page.getByTestId('chat-timeline')).toContainText(
        'Mock reply: Portrait chat check',
      );
      await capture('chat-reply');
      for (const tab of ['workspace', 'overview', 'packages', 'map']) {
        const trigger = page.getByTestId(`project-tab-${tab}`);
        if (await trigger.isVisible()) {
          await trigger.click();
          await capture(`project-${tab}`);
        }
      }
      for (const area of [
        'projects',
        'gezels',
        'tasks',
        'documents',
        'craftbooks',
        'scripts',
        'history',
        'knowledge',
      ]) {
        await openAreaView(page, area);
        await capture(area);
      }
      await openGezel(page, world!.gezelIds.ada);
      await expect(page.getByTestId('gezel-detail')).toBeVisible();
      await capture('gezel-detail');
      for (const label of ['About', 'Memories', 'Growth']) {
        const tab = page.getByRole('tab', { name: new RegExp(label, 'i') });
        if (await tab.isVisible()) {
          await tab.click();
          await capture(`gezel-${label.toLowerCase()}`);
        }
      }
      await openTask(page, world!.taskRefs[0]!);
      await expect(page.getByTestId('task-detail')).toBeVisible();
      await capture('task-detail');
      await page.locator('.step-tracker .bench-step-marker').first().click();
      await expect(page.getByTestId('task-step-panel')).toBeVisible();
      await capture('task-step');
      if (world!.craftbookId) {
        await openTab(page, { kind: 'craftbook', id: world!.craftbookId, source: 'local' });
        await expect(page.getByTestId('craftbook-editor')).toBeVisible();
        await capture('craftbook-editor');
      }
      await openTab(page, { kind: 'document', path: 'Welcome.md' });
      await expect(page.getByTestId('document-detail')).toBeVisible();
      await capture('document-detail');
      for (const [area, trigger] of [
        ['gezels', '+ New Gezel'],
        ['projects', '+ New Project'],
        ['tasks', '+ New task'],
      ]) {
        await openAreaView(page, area!);
        await page.getByRole('button', { name: trigger, exact: true }).click();
        const dialog = page.getByRole('dialog').last();
        await expect(dialog).toBeVisible();
        const bounds = (await dialog.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.width).toBeGreaterThanOrEqual(Math.min(300, profile.width - 30));
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(profile.width);
        expect(bounds.y).toBeGreaterThanOrEqual(profile.ios ? 50 : 0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(
          profile.height - (profile.ios ? 34 : 0),
        );
        await capture(`dialog-${area}`);
        if (area === 'projects') {
          await dialog.getByRole('radio', { name: 'General', exact: true }).click();
          await capture('dialog-project-configure');
        }
        await page.keyboard.press('Escape');
      }
      await openAreaView(page, 'settings');
      const picker = page.locator('.settings-nav-picker-trigger');
      await expect(picker).toBeVisible();
      await picker.click();
      await capture('settings-menu');
      expect(
        await page
          .getByRole('option')
          .first()
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Escape');
      for (let index = 0; ; index++) {
        await picker.click();
        const options = page.getByRole('option');
        if (index >= (await options.count())) {
          await page.keyboard.press('Escape');
          break;
        }
        const label = await options.nth(index).innerText();
        await options.nth(index).click();
        await capture(
          `settings-${label
            .trim()
            .replace(/[^a-z0-9]+/gi, '-')
            .toLowerCase()}`,
        );
      }
      await setTheme(page, 'dark');
      await capture('settings-dark');
      await openProject(page, world!.projectId);
      await page.getByTestId('project-tab-chat').click();
      await capture('chat-dark');
      await page.getByRole('button', { name: 'Navigation', exact: true }).click();
      await capture('navigation-dark');
    });
  });
}

test('small portrait create and edit workflows', async ({ page, daemon, world }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  test.skip(!world, 'requires the seeded world');
  const { GezelClient } = await import('@bendyline/gezel-client');
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  // The echo provider cannot draw an SVG. Keep the optional background icon
  // request deterministic while entity creation and persistence use the daemon.
  await page.route('**/api/gezels/*/icon/generate', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    await route.fulfill({ json: await client.getGezel(id) });
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  await openAreaView(page, 'gezels');
  await page.getByRole('button', { name: '+ New Gezel', exact: true }).click();
  const newGezel = page.getByRole('dialog', { name: 'New Gezel', exact: true });
  await newGezel.getByRole('textbox', { name: 'Name', exact: true }).fill('Portrait companion');
  await newGezel.getByRole('textbox', { name: 'Role', exact: true }).fill('Editor');
  await newGezel.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(newGezel).not.toBeVisible();
  await expect(page.getByTestId('gezel-detail')).toContainText('Portrait companion');

  await openAreaView(page, 'projects');
  await page.getByRole('button', { name: '+ New Project', exact: true }).click();
  await page.getByRole('dialog').getByRole('radio', { name: 'General', exact: true }).click();
  const newProject = page.getByRole('dialog', { name: 'General', exact: true });
  await newProject.getByRole('textbox', { name: 'Name', exact: true }).fill('Portrait workspace');
  await newProject
    .getByRole('textbox', { name: 'About', exact: true })
    .fill(
      'A workspace created from a small portrait screen to verify the complete mobile creation flow.',
    );
  await newProject.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(newProject).not.toBeVisible();
  await expect(page.getByTestId('project-tab-chat')).toBeVisible();

  await openAreaView(page, 'tasks');
  await page.getByRole('button', { name: '+ New task', exact: true }).click();
  const newTask = page.getByRole('dialog');
  await newTask.getByRole('radio', { name: 'General task', exact: true }).click();
  await newTask.getByRole('textbox', { name: 'Title', exact: true }).fill('Portrait checklist');
  await newTask
    .getByRole('textbox', { name: /^Description/ })
    .fill('Create a useful checklist with drafting and review steps from a small portrait screen.');
  await newTask.getByRole('textbox', { name: /^Steps/ }).fill('Draft\nReview');
  await newTask.getByRole('combobox', { name: 'Assign to', exact: true }).click();
  await page.getByRole('option', { name: 'Me (no gezel)', exact: true }).click();
  await newTask.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(newTask).not.toBeVisible();
  await expect(page.getByTestId('task-detail')).toContainText('Portrait checklist');

  await openTab(page, { kind: 'document', path: 'Welcome.md' });
  const doc = page.getByTestId('document-detail');
  await expect(doc).toBeVisible();
  const editor = doc.getByRole('textbox', { name: 'Edit Welcome.md', exact: true });
  await expect(editor).toContainText('This is a seeded fixture document');
  await editor.click();
  await editor.press('ControlOrMeta+End');
  await editor.press('Enter');
  await editor.pressSequentially('Saved from a small portrait screen.');
  await expect
    .poll(async () => (await client.readDocument('Welcome.md')).content)
    .toContain('Saved from a small portrait screen.');
  const exportButton = doc.getByRole('button', { name: 'Export document', exact: true });
  await expect(exportButton).toBeInViewport({ ratio: 1 });
  await exportButton.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await openAreaView(page, 'tasks');
  await openTab(page, { kind: 'document', path: 'Welcome.md' });
  await expect(editor).toContainText('Saved from a small portrait screen.');
});
