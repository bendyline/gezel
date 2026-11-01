import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GezelClient } from '@bendyline/gezel-client';
import { expect, test } from './fixtures/test.js';
import { catalogPages } from './helpers/catalog-apps.js';
import { gotoHome, openProject } from './helpers/nav.js';

test.use({ daemonGroup: 'catalog-app-host' });

for (const app of catalogPages()) {
  test(`${app.id}: adopts, embeds chat, persists page actions and preserves seeds on update`, async ({
    page,
    daemon,
  }, info) => {
    test.setTimeout(150_000);
    const api = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
    const manifest = JSON.parse(await readFile(join(app.dir, 'manifest.json'), 'utf8'));
    const project = await api.createProject({ name: `App audit ${app.id}` });
    await api.applyProjectType(project.id, { typeId: app.id, version: manifest.version });
    if (app.id === 'image-feed' || app.id === 'social-feed') {
      await api.writeProjectWorkspaceFile(project.id, {
        path: 'posts/workshop-note/post.md',
        content:
          '---\ntitle: A note from the workshop\nstatus: idea\nplatforms: [bluesky]\ncreated: 2026-11-01\n---\n\nA real post to review with the crew.\n',
      });
      await api.writeProjectWorkspaceFile(project.id, {
        path: 'posts/index.json',
        content: JSON.stringify({
          posts: [
            {
              id: 'workshop-note',
              title: 'A note from the workshop',
              status: 'idea',
              platforms: ['bluesky'],
              created: '2026-11-01',
            },
          ],
        }),
      });
    }
    await gotoHome(page);
    await openProject(page, project.id);
    const frame = page.frameLocator('.project-output-iframe iframe');
    await expect(frame.locator('gezel-app-layout')).toHaveCount(1);
    await page.keyboard.press('F5');
    if (app.id !== 'media-library') {
      const chat = page.locator('.page-chat-slot');
      await expect(chat).toBeVisible();
      const editor = chat.locator('.squisq-wysiwyg-editor');
      await expect(editor).toBeVisible();
      await editor.fill('A draft to keep while working.');
      await frame.getByRole('button', { name: 'Hide conversation' }).click();
      await expect(chat).toBeHidden();
      await frame.getByRole('button', { name: 'Show conversation' }).click();
      await expect(editor).toHaveText('A draft to keep while working.');
      await page.getByRole('button', { name: 'Restore output pane', exact: true }).click();
      await expect(chat).toBeHidden();
      await page.keyboard.press('F5');
      await expect(editor).toHaveText('A draft to keep while working.');
      if (app.id === 'language-trainer') {
        await editor.fill('Let’s practice ordering coffee.');
        await editor.press('Enter');
        await expect(chat).toContainText('Mock reply:', { timeout: 30_000 });
        const detail = await api.getProject(project.id);
        const sessions = await api.listChatSessions({ projectId: project.id });
        expect(
          sessions.sessions.every((session) => session.gezelId === detail.voormanGezelId),
        ).toBe(true);
      }
    }
    const forms = frame.locator('gezel-action-form');
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
          const preferred =
            name === 'stage' ? (app.id === 'job-hunt' ? 'screening' : 'drafting') : undefined;
          await control.selectOption(
            preferred ?? (await control.locator('option').last().getAttribute('value'))!,
          );
        } else {
          await control.fill(
            type === 'number'
              ? '7'
              : type === 'date'
                ? '2026-11-20'
                : type === 'url'
                  ? 'https://example.com/job'
                  : name === 'colors'
                    ? '#27352D, #557A5B, #FAF7F2'
                    : name === 'donor'
                      ? 'Mara'
                      : name === 'date'
                        ? 'Day 1'
                        : 'A useful test note',
          );
        }
      }
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(form.getByRole('status')).toHaveText('Saved.', { timeout: 20_000 });
      await form.locator('summary').click();
    }
    if (await forms.count()) {
      // Real state must survive both a reread and reapplication of the app definition.
      const paths: string[] = manifest.workspaceSeed ?? [];
      const before = await Promise.all(
        paths.map((path) => api.readProjectWorkspaceFile(project.id, path)),
      );
      await api.applyProjectType(project.id, {
        typeId: app.id,
        version: manifest.version,
        seedPolicy: 'preserve',
      });
      const after = await Promise.all(
        paths.map((path) => api.readProjectWorkspaceFile(project.id, path)),
      );
      expect(after.map((file) => file.content)).toEqual(before.map((file) => file.content));
      await expect(
        api.invokeProjectPageTool(project.id, { tool: 'not_a_declared_page_action', input: {} }),
      ).rejects.toThrow();
    }
    if (app.id === 'image-feed' || app.id === 'social-feed') {
      await frame.locator('[data-post="workshop-note"]').click();
      await expect(frame.getByRole('dialog')).toContainText('A real post to review with the crew.');
      await expect(page.locator('.page-chat-slot')).toBeHidden();
      await frame.locator('[data-move="draft"]').click();
      await expect(frame.locator('#d-meta')).toContainText('draft');
      expect(
        (await api.readProjectWorkspaceFile(project.id, 'posts/workshop-note/post.md')).content,
      ).toContain('status: draft');
      await frame.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.locator('.page-chat-slot')).toBeVisible();
    }
    await expect(frame.locator('#app-load-error')).toBeHidden();
    await page.screenshot({ path: info.outputPath(`${app.id}-host.png`) });
  });
}

test('page edits respect a denied workspace policy and retain the entered draft', async ({
  page,
  daemon,
}) => {
  test.skip(!process.env.GILDE_DIR, 'Requires the catalog checkout.');
  const app = catalogPages().find((app) => app.id === 'meal-planner')!;
  const manifest = JSON.parse(await readFile(join(app.dir, 'manifest.json'), 'utf8'));
  const api = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  const project = await api.createProject({ name: 'Read-only kitchen' });
  await api.applyProjectType(project.id, { typeId: app.id, version: manifest.version });
  const before = await api.readProjectWorkspaceFile(project.id, 'menu.json');
  await api.updateProject(project.id, { managedWorkspaceWritePolicy: 'deny' });
  await gotoHome(page);
  await openProject(page, project.id);
  const frame = page.frameLocator('.project-output-iframe iframe');
  const form = frame.locator('gezel-action-form').filter({ hasText: 'Plan a meal' });
  await form.locator('summary').click();
  await form.getByLabel('Meal', { exact: true }).fill('A meal to keep in the draft');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form.getByRole('status')).toContainText('Could not save.');
  await expect(form.getByLabel('Meal', { exact: true })).toHaveValue('A meal to keep in the draft');
  expect((await api.readProjectWorkspaceFile(project.id, 'menu.json')).content).toBe(
    before.content,
  );
  await expect(
    api.invokeProjectPageTool(project.id, {
      tool: 'set_menu',
      input: { day: 'monday', meal: 'not allowed' },
    }),
  ).rejects.toThrow();
});
