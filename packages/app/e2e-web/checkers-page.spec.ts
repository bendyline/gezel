import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GezelClient } from '@bendyline/gezel-client';
import { writePageDemo, writePageDemoAssets } from '../../cli/src/page-demo-export.js';
import { LAYOUT_TOLERANCE_PX } from '../e2e/helpers/layout.js';
import { expect, test } from './fixtures/test.js';
import { setTheme } from './helpers/determinism.js';
import { gotoHome, openProject } from './helpers/nav.js';

const gilde = process.env.GILDE_DIR;
test.use({ daemonGroup: 'checkers-page' });
test.skip(!gilde, 'Set GILDE_DIR and GEZEL_GILDE_DATA_DIR to test the catalog checkout.');

test('checkers uses native opponent chat only while expanded and preserves it through dialogs and resizing', async ({
  page,
  daemon,
}, info) => {
  test.setTimeout(120_000);
  const api = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  const project = await api.createProject({ name: 'Checkers chat test' });
  await api.applyProjectType(project.id, { typeId: 'checkers', version: '1.2.5' });
  const detail = await api.getProject(project.id);
  const originalGame = await api.readProjectWorkspaceFile(project.id, 'game.json');

  await gotoHome(page);
  await openProject(page, project.id);
  const board = page.frameLocator('.project-output-iframe iframe');
  await expect(board.locator('#board .piece')).toHaveCount(24);
  await expect(board.locator('#opponent-chat-panel')).toBeHidden();
  await expect(page.locator('.page-chat-slot')).toHaveCount(0);
  await page.keyboard.press('F5');
  await expect(board.getByRole('heading', { name: 'Table talk' })).toBeVisible();
  const chat = page.locator('.page-chat-slot');
  await expect(chat).toBeVisible();
  await expect(chat.locator('.chat-composer-to')).toHaveCount(0);
  const editor = chat.locator('.squisq-wysiwyg-editor');
  await editor.fill('Good game! What do you enjoy about checkers?');
  await editor.press('Enter');
  await expect(chat).toContainText('Mock reply:', { timeout: 30_000 });
  const sessions = await api.listChatSessions({ projectId: project.id });
  expect(sessions.sessions.length).toBeGreaterThan(0);
  expect(sessions.sessions.every((session) => session.gezelId === detail.voormanGezelId)).toBe(
    true,
  );
  expect((await api.readProjectWorkspaceFile(project.id, 'game.json')).content).toBe(
    originalGame.content,
  );

  await editor.fill('I have a move in mind.');
  await board.getByRole('button', { name: 'New game', exact: true }).click();
  await expect(board.getByRole('dialog')).toBeVisible();
  await expect(chat).toBeHidden();
  await board.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toHaveText('I have a move in mind.');
  await page.getByRole('button', { name: 'Restore output pane', exact: true }).click();
  await expect(chat).toBeHidden();
  await page.keyboard.press('F5');
  await expect(editor).toHaveText('I have a move in mind.');

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: info.outputPath(`checkers-chat-${theme}.png`) });
  }
  await page.setViewportSize({ width: 560, height: 900 });
  await board.locator('#opponent-chat').scrollIntoViewIfNeeded();
  await expect(editor).toHaveText('I have a move in mind.');
  const box = await chat.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(-LAYOUT_TOLERANCE_PX);
  expect(box!.x + box!.width).toBeLessThanOrEqual(560 + LAYOUT_TOLERANCE_PX);
  await page.screenshot({ path: info.outputPath('checkers-chat-narrow.png') });
});

test('the exported checkers demo keeps hot-seat moves and never simulates opponent chat', async ({
  page,
}, info) => {
  const source = join(
    gilde!,
    'data/project-types/ch/checkers/versions/1.2.5/pages/board/index.html',
  );
  const directory = info.outputPath('demo');
  const sharedDirectory = join(directory, '_gezel-demo');
  await writePageDemo(
    directory,
    [{ path: 'board/index.html', bytes: await readFile(source) }],
    {},
    {
      directory: sharedDirectory,
      assets: await writePageDemoAssets(sharedDirectory),
    },
  );
  await page.goto(pathToFileURL(join(directory, 'board/index.html')).href);
  await expect(page.locator('[data-gezel-demo-banner]')).toBeVisible();
  await expect(page.locator('#board .piece')).toHaveCount(24);
  await page.locator('[data-square="c3"]').click();
  await page.locator('[data-square="d4"]').click();
  await expect(page.locator('#log')).toContainText('c3');
  await page.evaluate(() => document.documentElement.requestFullscreen());
  await expect(page.locator('#opponent-chat-panel')).toBeVisible();
  await expect(page.locator('#chat-unavailable')).toContainText('available when you play in Gezel');
  await expect(page.locator('gezel-chat')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset demo' }).click();
  await expect(page.locator('#log')).toContainText('No moves yet');
  await expect(page.locator('#board .piece')).toHaveCount(24);
});
