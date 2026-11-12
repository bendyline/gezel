import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { GezelClient } from '@bendyline/gezel-client';
import { scaffoldGezappSource } from '../../cli/src/app-scaffold.js';
import { packGezappFromSource } from '../../service/src/project-type/gezapp-source.js';
import { LAYOUT_TOLERANCE_PX } from '../e2e/helpers/layout.js';
import { expect, test } from './fixtures/test.js';
import { setTheme } from './helpers/determinism.js';
import { gotoHome, openProject } from './helpers/nav.js';

test.use({ daemonGroup: 'page-chat' });

const fixturePage = `<!doctype html><html><head><title>Game chat</title><style>
body{margin:0;padding:16px;box-sizing:border-box}#game{display:grid;gap:16px;grid-template-columns:1fr}
#board{height:240px;background:repeating-conic-gradient(#e0d7c4 0 25%,#627357 0 50%) 0/60px 60px}
#chat{display:none;height:65vh;min-width:0}html[data-gezel-fullscreen=true] #game{grid-template-columns:minmax(0,1fr) 360px}
html[data-gezel-fullscreen=true] #chat{display:block}@media(max-width:700px){html[data-gezel-fullscreen=true] #game{grid-template-columns:1fr}}
</style></head><body><h1>Game chat</h1><output id="state"></output><div id="game"><div id="board"></div><div id="chat"></div></div>
<script>
const chat=gezel.ui.components.chat('#chat',{showAddress:false,showThreads:false,placeholder:'Ask about a move'});
function layout(value){document.querySelector('#state').textContent=value.fullscreen?'Full screen':'In a pane';}
layout(gezel.ui.layout);gezel.ui.onLayout(layout);
</script></body></html>`;

test('an installed page embeds native chat, sends to its crew, and keeps the draft across fullscreen changes', async ({
  page,
  daemon,
}, info) => {
  test.setTimeout(120_000);
  const api = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  const source = join(daemon.home, 'chat-source');
  for (const [path, content] of scaffoldGezappSource('chat-board', { withPage: true })) {
    const target = join(source, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, path.endsWith('/pages/dashboard/index.html') ? fixturePage : content);
  }
  const packed = await packGezappFromSource(source);
  await api.importAiAppPackage(packed.buffer, { confirm: true });
  const project = await api.createProject({
    name: 'Chat board',
    about: 'A game board used to verify native chat inside a sandboxed project page.',
    missionObjectives: 'Keep the game and native conversation together as the page expands.',
  });
  await api.applyProjectType(project.id, { typeId: 'chat-board' });
  await gotoHome(page);
  await openProject(page, project.id);
  const app = page.frameLocator('.project-output-iframe iframe');
  await expect(app.locator('#state')).toHaveText('In a pane');
  await page.keyboard.press('F5');
  await expect(app.locator('#state')).toHaveText('Full screen');
  const chat = page.locator('.page-chat-slot');
  await expect(chat).toBeVisible();
  await expect(chat.locator('.chat-composer-to')).toHaveCount(0);
  const editor = chat.locator('.squisq-wysiwyg-editor');
  await expect(editor).toBeVisible();
  await editor.fill('Why is this move useful?');
  await page.keyboard.press('F5');
  await expect(app.locator('#state')).toHaveText('In a pane');
  await expect(chat).toBeHidden();
  await page.keyboard.press('F5');
  await expect(editor).toHaveText('Why is this move useful?');
  await editor.press('Enter');
  await expect(chat).toContainText('Mock reply:', { timeout: 30_000 });
  const detail = await api.getProject(project.id);
  const sessions = await api.listChatSessions({ projectId: project.id });
  expect(sessions.sessions.some((session) => session.gezelId === detail.voormanGezelId)).toBe(true);
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: info.outputPath(`page-chat-${theme}.png`) });
  }
  await page.setViewportSize({ width: 560, height: 900 });
  await expect(editor).toBeVisible();
  const box = await chat.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(560 + LAYOUT_TOLERANCE_PX);
});

test('fullscreen keeps navigation and each project restores its own page mode', async ({
  page,
  daemon,
}, info) => {
  test.setTimeout(120_000);
  const api = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  const board = await api.createProject({ name: 'Fullscreen board' });
  const notes = await api.createProject({ name: 'Closed page' });
  for (const project of [board, notes]) {
    await api.writeProjectWorkspaceFile(project.id, {
      path: 'index.html',
      content:
        '<!doctype html><html><body><h1>My board</h1><input aria-label="Board name"></body></html>',
    });
  }
  await gotoHome(page);
  await openProject(page, notes.id);
  await page.getByRole('button', { name: 'Hide output pane', exact: true }).first().click();
  await expect.poll(async () => (await api.getProject(notes.id)).outputPaneVisible).toBe(false);
  await openProject(page, board.id);
  // The pane on screen: a project left behind stays mounted, hidden (kept alive).
  const pane = page.locator('.project-output-pane').filter({ visible: true });
  const iframe = pane.locator('iframe');
  const input = page
    .frameLocator('.project-output-pane iframe')
    .getByRole('textbox', { name: 'Board name' });
  await input.fill('Keep this board');
  const originalFrame = await iframe.elementHandle();
  await page.getByRole('button', { name: 'Maximize output pane', exact: true }).click();
  await expect(pane).toHaveClass(/project-output-pane-maximized/);
  await expect.poll(async () => (await api.getProject(board.id)).outputPaneMaximized).toBe(true);
  const sidebar = page.getByTestId('app-sidebar');

  for (const side of ['left', 'right']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.sidebarSide = value;
    }, side);
    for (const collapsed of [false, true]) {
      if (collapsed)
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      await expect(sidebar).toBeVisible();
      await expect
        .poll(async () => {
          const nav = await sidebar.boundingBox();
          const output = await pane.boundingBox();
          const header = await page.getByTestId('app-header').boundingBox();
          if (!nav || !output || !header) return false;
          const separate =
            side === 'left'
              ? output.x >= nav.x + nav.width - LAYOUT_TOLERANCE_PX
              : output.x + output.width <= nav.x + LAYOUT_TOLERANCE_PX;
          return separate && output.y >= header.y + header.height - LAYOUT_TOLERANCE_PX;
        })
        .toBe(true);
      await expect(input).toHaveValue('Keep this board');
      expect(await originalFrame!.evaluate((element) => element.isConnected)).toBe(true);
      await page.screenshot({
        path: info.outputPath(`fullscreen-${side}-${collapsed ? 'collapsed' : 'expanded'}.png`),
      });
    }
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  }

  // Use actual navigation while the page is expanded, then reload the shell.
  await page.getByTestId('sidebar-area-settings').click();
  await expect(pane).toHaveCount(0);
  await openProject(page, notes.id);
  await expect(page.getByRole('button', { name: 'Show output pane', exact: true })).toBeVisible();
  await expect(pane).toHaveCount(0);
  await openProject(page, board.id);
  await expect(pane).toHaveClass(/project-output-pane-maximized/);
  await page.reload();
  await expect(pane).toHaveClass(/project-output-pane-maximized/);
  await page.keyboard.press('Escape');
  await expect(pane).not.toHaveClass(/project-output-pane-maximized/);
  await expect.poll(async () => (await api.getProject(board.id)).outputPaneMaximized).toBe(false);
  await page.reload();
  await expect(pane).toBeVisible();
  await expect(pane).not.toHaveClass(/project-output-pane-maximized/);
  await openProject(page, notes.id);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show output pane', exact: true })).toBeVisible();
  await expect(pane).toHaveCount(0);
});
