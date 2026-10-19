/**
 * First visit to a project with no chat history: the status band stays quiet,
 * while the timeline guidance and composer remain ready for the first message.
 * Uses the isolated browser-suite daemon and a fresh project to avoid seeded work.
 */
import { GezelClient } from '@bendyline/gezel-client';
import { expect, test } from './fixtures/test.js';
import { setTheme, settle } from './helpers/determinism.js';
import { gotoHome, openProject } from './helpers/nav.js';

test.use({ daemonGroup: 'empty-project-chat' });

test('first project visit has no recent-threads placeholder', async ({
  page,
  daemon,
  world,
}, testInfo) => {
  test.skip(!world, 'requires the seeded roster');
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  const project = await client.createProject({
    name: 'New Project',
    about:
      'A fresh project for checking the first visit to a conversation with no previous chat history.',
    missionObjectives: 'Keep the first conversation clear and ready for a new message.',
  });
  await client.addGezelToProject(project.id, world!.gezelIds.ada);
  await client.updateProject(project.id, { voormanGezelId: world!.gezelIds.ada });

  await gotoHome(page);
  await openProject(page, project.id);
  await expect(page.getByTestId('project-tab-chat')).toBeVisible();
  await expect(page.getByTestId('chat-timeline')).toContainText('Talk to Ada Lovelace');
  const statusBand = page.getByRole('toolbar', { name: 'Threads, terminal windows, and tasks' });
  await expect(statusBand).toHaveText('');
  await expect(page.getByText('No recent threads', { exact: true })).toHaveCount(0);
  const editor = page
    .getByTestId('chat-composer')
    .getByRole('textbox', { name: 'Message', exact: true });
  await expect(editor).toBeEditable();

  await setTheme(page, 'dark');
  await settle(page);
  await page.screenshot({ path: testInfo.outputPath('empty-project-chat.png'), fullPage: true });
  await editor.fill('Hello from my new project');
  await expect(editor).toHaveText('Hello from my new project');
});
