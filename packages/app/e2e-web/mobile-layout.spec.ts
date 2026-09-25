import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GezelClient } from '@bendyline/gezel-client';
import { expect, test } from './fixtures/test.js';

test('the desktop app becomes the mobile workshop at phone width', async ({
  page,
  world,
  daemon,
}) => {
  test.skip(!world, 'requires the seeded world');
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  await client.writeProjectWorkspaceFile(world!.projectId, {
    path: 'Mobile notes.md',
    content: '# Mobile notes\n\nPhone workspace verification.\n',
  });
  const screenshots = process.env.GEZEL_RESPONSIVE_SHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const capture = async (name: string) => {
    if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`) });
  };
  const noOverflow = async () => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  };

  await page.setViewportSize({ width: 400, height: 844 });
  await page.goto('/');
  const sidebar = page.getByTestId('app-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole('main')).not.toBeVisible();
  const project = sidebar
    .locator('.app-sidebar-proj-row > .app-sidebar-item')
    .filter({ hasText: 'Fixture Project' })
    .first();
  await expect(project).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(390);
  await noOverflow();
  await capture('desktop400nav');

  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'darwin';
  });
  await expect
    .poll(() =>
      page
        .locator('.app-header')
        .evaluate((header) => Number.parseFloat(getComputedStyle(header).paddingLeft)),
    )
    .toBe(83);
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'win32';
  });
  await expect
    .poll(() =>
      page
        .locator('.app-header')
        .evaluate((header) => Number.parseFloat(getComputedStyle(header).paddingRight)),
    )
    .toBeGreaterThanOrEqual(140);
  await page.evaluate(() => {
    delete document.documentElement.dataset.platform;
  });

  await project.click();
  await expect(page.getByTestId('project-tab-chat')).toBeVisible();
  await expect(page.locator('.project-compact-heading h2')).toHaveText('Fixture Project');
  await expect(sidebar).not.toBeVisible();
  const editor = page.getByTestId('chat-composer').locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  await editor.fill('Keep this draft while resizing the workshop.');
  await expect(page.getByText('Hello from the web e2e seed', { exact: true })).toBeVisible();
  const latestReply = page.getByText('Mock reply: Hello from the web e2e seed', { exact: true });
  await expect(latestReply).toBeInViewport({
    ratio: 1,
  });
  await noOverflow();
  await capture('desktop400project');

  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  await expect(sidebar).toBeVisible();
  await project.click();
  await expect(editor).toHaveText('Keep this draft while resizing the workshop.');

  await page.getByTestId('project-tab-workspace').click();
  const notes = page.getByRole('button', { name: 'Mobile notes.md', exact: true });
  await expect(notes).toBeVisible();
  await notes.click();
  await expect(page.getByRole('button', { name: 'Back to files', exact: true })).toBeVisible();
  await expect(page.locator('.file-viewer-panel:visible')).toContainText(
    'Phone workspace verification.',
  );
  await noOverflow();
  await capture('desktop400file');
  await page.getByRole('button', { name: 'Back to files', exact: true }).click();
  await expect(notes).toBeVisible();
  await page.getByTestId('project-tab-chat').click();
  await expect(editor).toHaveText('Keep this draft while resizing the workshop.');

  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(sidebar).toBeVisible();
  await expect(editor).toBeVisible();
  await noOverflow();
  await capture('desktop768');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(editor).toHaveText('Keep this draft while resizing the workshop.');
  await expect(latestReply).toBeInViewport({
    ratio: 1,
  });
  await noOverflow();
  await capture('desktopwide');

  await page.goto('/?layout=mobile');
  await expect(sidebar).toBeVisible();
  await expect(project).toBeVisible();
  expect((await page.locator('.app').boundingBox())?.width).toBe(390);
  await capture('desktoppreview');
  await page.getByRole('button', { name: 'Exit mobile preview' }).click();
  await expect(page.locator('.app-mobile-preview')).toHaveCount(0);
  await expect(page.getByTestId('project-tab-chat')).toBeVisible();
  await expect(sidebar).toBeVisible();

  // This worker's daemon is reused by later specs. The draft was only needed
  // to verify resizing, so clear it and wait for its autosave deletion.
  await editor.fill('');
  await expect
    .poll(async () => {
      const { drafts } = await client.listPromptDrafts(world!.projectId, {
        gezelId: world!.gezelIds.ada,
        status: 'draft',
      });
      return drafts.some((draft) => draft.title.startsWith('Keep this draft while resizing'));
    })
    .toBe(false);
});
