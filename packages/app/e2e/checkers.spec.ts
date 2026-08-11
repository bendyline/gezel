import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { buildLaunchEnv } from './helpers/launch-env.js';

/**
 * End-to-end: the interactive-page rails through the shipped Checkers type
 * — gallery create, a playable board in the sandboxed Output iframe, a
 * user move relayed over the page-invoke bridge, and the reaction seed
 * summoning the Damspeler's turn in the visible project chat. The seed is
 * machine facilitation and stays hidden from the user. The AI's
 * answering move is covered by unit/integration tests (the mock provider
 * here replies with text but plays no move, which conveniently freezes
 * the "thinking" state for assertion).
 */

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

function boardPosition(pieces: Record<string, string>): string {
  const squares = Array.from({ length: 64 }, () => '.');
  for (const [name, piece] of Object.entries(pieces)) {
    const x = 'abcdefgh'.indexOf(name[0]!.toLowerCase());
    const y = 8 - Number(name[1]);
    squares[y * 8 + x] = piece;
  }
  return squares.join('');
}

async function checkersWorkspace(): Promise<string> {
  const projectsDir = join(gezelHome, 'projects');
  for (const id of await readdir(projectsDir)) {
    try {
      const project = JSON.parse(await readFile(join(projectsDir, id, 'project.json'), 'utf8'));
      if (project.projectType?.id === 'checkers') return join(projectsDir, id, 'workspace');
    } catch {
      // Ignore non-project entries while locating the E2E-created project.
    }
  }
  throw new Error('Checkers project workspace not found');
}

test.setTimeout(120_000);

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-checkers-e2e-'));
  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
      // Memory extraction is orthogonal to this board/reaction scenario and
      // turns the mock's echoed facilitation prompt into dozens of fake facts.
      GEZEL_DISABLE_MEMORY_EXTRACTION: '1',
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('[data-testid="app-sidebar"]')).toBeVisible({ timeout: 20_000 });
});

test.afterAll(async () => {
  // Two MCP-backed reaction turns can make graceful embedded shutdown take
  // longer than Playwright's 30s hook default while their bridges close.
  test.setTimeout(60_000);
  await app?.close();
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('checkers: create from gallery, move on the board, the reaction summons the Damspeler', async () => {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('gezel:open-tab', { detail: { kind: 'area', area: 'projects' } }),
    );
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gezel:new-project')));

  // The bundled Checkers type lights the Games rail.
  const card = page.getByRole('radio', { name: 'Checkers' });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
  await expect(card).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue(
    'Checkers vs the Damspeler',
  );
  await expect(page.getByRole('button', { name: 'Opponent', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: /^Create/ }).click();

  // The pinned board renders the seeded opening: 24 pieces, red to move.
  const board = page.frameLocator('iframe.project-output-iframe');
  await expect(board.locator('.piece')).toHaveCount(24, { timeout: 20_000 });
  await expect(board.getByText('Your move')).toBeVisible();
  await expect(board.getByText('{{')).toHaveCount(0);
  await expect(board.locator('.coord')).toHaveCount(64);
  await expect(board.locator('[data-square="d4"] .coord')).toHaveText('D4');
  await expect(board.locator('[data-square="e6"] .coord')).toHaveText('E6');

  // A king label must not contribute intrinsic row height and distort the
  // board. Reproduce that content shape and verify all 64 tracks stay square.
  await board.locator('[data-square="b8"] .piece').evaluate((piece) => {
    piece.textContent = 'K';
  });
  const cellSizes = await board.locator('.cell').evaluateAll((cells) =>
    cells.map((cell) => {
      const rect = cell.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  const widths = cellSizes.map(({ width }) => width);
  const heights = cellSizes.map(({ height }) => height);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.5);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.5);
  expect(Math.abs(widths[0]! - heights[0]!)).toBeLessThan(0.5);

  // New games offer the standard capture rule or a house-rule variant
  // where an ordinary move remains legal even when a capture is available.
  const newGameDialog = board.getByRole('dialog', { name: 'New game' });
  await expect(async () => {
    if (!(await newGameDialog.isVisible())) {
      await board.getByRole('button', { name: 'New game' }).click();
    }
    await expect(newGameDialog).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 10_000 });
  const optionalCaptures = board.getByRole('radio', { name: /Optional/ });
  await optionalCaptures.click();
  await expect(optionalCaptures).toHaveAttribute('aria-checked', 'true');
  await board.getByRole('button', { name: 'Start game' }).click();
  await expect(board.getByText('Your move — captures are optional.')).toBeVisible({
    timeout: 15_000,
  });

  // Click c3, take the highlighted d4 — the move rides the postMessage
  // bridge through the page-invoke route into the ScriptRunner.
  await board.locator('[data-square="c3"]').click();
  await expect(board.locator('[data-square="d4"].hint')).toBeVisible();
  await board.locator('[data-square="d4"]').click();

  // Full happy path on every platform: game-store is catalog-shipped and
  // byte-verified, so the provenance-trusted sandbox lane executes it even
  // where denyNet has no OS boundary (Windows; Linux under the RPC
  // channel). The engine applies the move (a red piece now sits on d4) and
  // the reaction summons the Damspeler; the mock provider never plays a
  // move back, so the thinking state persists.
  await expect(board.locator('[data-square="d4"] .piece.red')).toBeVisible({ timeout: 15_000 });
  await expect(board.getByText('Damspeler is thinking')).toBeVisible();
  await expect(board.getByText('Red c3-d4')).toBeVisible();
  // The machine-authored reaction seed stays out of the transcript, while
  // the Damspeler's resulting turn renders beside the board. Wait for the
  // mock reply to finish so this background turn cannot leak into teardown.
  const timeline = page.getByTestId('chat-timeline');
  const damspelerTurns = timeline.locator('.msg-assistant').filter({ hasText: 'Damspeler' });
  await expect(damspelerTurns.first()).toBeVisible({ timeout: 20_000 });
  await expect(timeline.locator('.msg-user')).toHaveCount(0);
  // Hidden machine-authored reactions must bypass auto-recall. Otherwise the
  // first turn can cold-load the embedding model against the freshly-created
  // workspace index and leave this healthy mock reply "Thinking…" for minutes.
  // Wait on the exact reaction bubble so this remains a regression assertion
  // for that lifecycle, not merely a count of unrelated assistant turns.
  await expect(damspelerTurns.first()).not.toHaveClass(/(?:msg-thinking|msg-streaming)/, {
    timeout: 30_000,
  });

  // Consecutive replies suppress their repeated author header, so count the
  // completed assistant bubbles rather than coupling the second turn to
  // header text.
  const completedAssistantTurns = timeline.locator(
    '.msg-assistant:not(.msg-thinking):not(.msg-streaming)',
  );
  await expect(completedAssistantTurns).toHaveCount(1);

  // Seed a deterministic two-hop capture. Only the first landing is offered;
  // dragging there previews the capture locally, then the second landing is
  // offered and the complete authoritative move is submitted after that hop.
  const workspace = await checkersWorkspace();
  const multiJump = {
    version: 1,
    squares: boardPosition({ c3: 'r', d4: 'b', f6: 'b', a7: 'b' }),
    turn: 'user',
    status: 'playing',
    userColor: 'red',
    forceCaptures: true,
    legalMoves: [
      {
        from: 'c3',
        to: 'g7',
        path: ['c3', 'e5', 'g7'],
        captures: ['d4', 'f6'],
      },
    ],
    moveLog: [],
    lastMove: null,
    lastQuip: '',
    updatedAt: new Date().toISOString(),
  };
  const gameFile = join(workspace, 'game.json');
  await writeFile(gameFile, `${JSON.stringify(multiJump, null, 2)}\n`, 'utf8');
  // This is test-only state seeding, outside the page-invoke bridge. Reload
  // the preview explicitly instead of racing its next background poll. The
  // old frame can observe the file write before React finishes minting the
  // replacement capability, so wait for the iframe URL itself to change.
  const previewFrame = page.locator('iframe.project-output-iframe');
  const previewSrcBeforeReload = await previewFrame.getAttribute('src');
  expect(previewSrcBeforeReload).toBeTruthy();
  const reloadPreview = page.getByRole('button', { name: 'Reload the preview' });
  if (await reloadPreview.isVisible()) {
    await reloadPreview.click();
  } else {
    await page.getByRole('button', { name: 'More output actions' }).click();
    await page.getByRole('menuitem', { name: 'Reload' }).click();
  }
  await expect
    .poll(
      async () => {
        const currentSrc = await previewFrame.getAttribute('src');
        return Boolean(currentSrc && currentSrc !== previewSrcBeforeReload);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  const seededOrigin = board.locator('[data-square="c3"]');
  await expect(seededOrigin.locator('.piece.red')).toBeVisible({ timeout: 10_000 });
  // The freshly remounted page can rebuild the board while Playwright's
  // pointer sequence is in flight. In that narrow window the click completes
  // against the detached cell without selecting its replacement. Retry the
  // action only while the live origin is still unselected; once selection
  // lands, the following assertions continue against the rebuilt DOM.
  await expect(async () => {
    const classes = (await seededOrigin.getAttribute('class'))?.split(/\s+/) ?? [];
    if (!classes.includes('selected')) await seededOrigin.click();
    await expect(seededOrigin).toHaveClass(/selected/, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(board.locator('[data-square="e5"].hint')).toBeVisible();
  await expect(board.locator('[data-square="g7"].hint')).toHaveCount(0);

  const c3 = await board.locator('[data-square="c3"] .piece').boundingBox();
  const e5 = await board.locator('[data-square="e5"]').boundingBox();
  if (!c3 || !e5) throw new Error('multi-jump drag geometry unavailable');
  await page.mouse.move(c3.x + c3.width / 2, c3.y + c3.height / 2);
  await page.mouse.down();
  await page.mouse.move(e5.x + e5.width / 2, e5.y + e5.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect(board.locator('[data-square="e5"] .piece.red')).toBeVisible({ timeout: 5_000 });
  await expect(board.locator('[data-square="d4"] .piece')).toHaveCount(0);
  await expect(board.locator('[data-square="g7"].hint')).toBeVisible();
  const beforeFinalHop = JSON.parse(await readFile(gameFile, 'utf8'));
  expect(beforeFinalHop.moveLog).toHaveLength(0);
  expect(beforeFinalHop.squares).toBe(multiJump.squares);

  await board.locator('[data-square="g7"]').click();
  await expect(board.locator('[data-square="g7"] .piece.red')).toBeVisible({ timeout: 10_000 });
  await expect(board.getByText('Red c3xg7')).toBeVisible();
  await expect(completedAssistantTurns).toHaveCount(2, { timeout: 30_000 });
  await page.screenshot({ path: '/tmp/gezel-checkers-board.png', fullPage: false });
});
