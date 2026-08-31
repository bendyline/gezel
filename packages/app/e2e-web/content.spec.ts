/**
 * Content areas — craftbooks, scripts, documents, history. All read off the
 * seeded world (a craftbook, a document tree, seeded chat sessions for history).
 */
import { expect, test } from './fixtures/test.js';
import { gotoHome, openAreaView, openTab } from './helpers/nav.js';
import { shot } from './helpers/shot.js';

test.describe('craftbooks', () => {
  test('list + editor', async ({ page, world }) => {
    await gotoHome(page);
    await openAreaView(page, 'craftbooks');
    await expect(page.getByTestId('craftbooks-view')).toBeVisible();

    const workspace = page.getByTestId('craftbooks-view');
    const library = page.getByRole('complementary', { name: 'Craftbook library' });
    const editor = page.getByRole('region', { name: 'Craftbook editor' });
    const [workspaceBox, libraryBox, editorBox] = await Promise.all([
      workspace.boundingBox(),
      library.boundingBox(),
      editor.boundingBox(),
    ]);
    expect(workspaceBox).not.toBeNull();
    expect(libraryBox).not.toBeNull();
    expect(editorBox).not.toBeNull();
    expect(Math.abs(libraryBox!.x - workspaceBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(libraryBox!.y - workspaceBox!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(libraryBox!.height - workspaceBox!.height)).toBeLessThanOrEqual(1);
    expect(editorBox!.x).toBeGreaterThan(libraryBox!.x + libraryBox!.width);
    expect(Math.abs(editorBox!.y - libraryBox!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(editorBox!.height - libraryBox!.height)).toBeLessThanOrEqual(1);
    expect(await library.evaluate((element) => getComputedStyle(element).borderRadius)).not.toBe(
      '0px',
    );

    await shot(page, 'list', {
      area: 'craftbooks',
      description: 'Craftbooks workspace — library rail and full-height editor',
    });

    if (world?.craftbookId) {
      await openTab(page, { kind: 'craftbook', id: world.craftbookId, source: 'local' });
      const editor = page.getByTestId('craftbook-editor');
      await expect(editor).toBeVisible();
      await shot(page, 'editor', {
        area: 'craftbooks',
        clip: editor,
        selector: '[data-testid=craftbook-editor]',
        description: 'Craftbook editor — the seeded "Fixture Craftbook" steps',
      });
    }
  });
});

test.describe('scripts', () => {
  test('list', async ({ page }) => {
    await gotoHome(page);
    await openAreaView(page, 'scripts');
    await expect(page.getByTestId('scripts-view')).toBeVisible();
    await shot(page, 'list', { area: 'scripts', description: 'Scripts list' });
  });
});

test.describe('documents', () => {
  test('tree + detail', async ({ page, world }) => {
    await gotoHome(page);
    await openAreaView(page, 'documents');
    await expect(page.getByTestId('documents-view')).toBeVisible();

    const search = page.getByRole('searchbox', { name: 'Search document contents' });
    const createTray = page.locator('.file-create-tray');
    const [searchBox, createTrayBox] = await Promise.all([
      search.boundingBox(),
      createTray.boundingBox(),
    ]);
    expect(searchBox).not.toBeNull();
    expect(createTrayBox).not.toBeNull();
    // The input is the header's shrinkable cell. Its right border must remain
    // visible instead of extending underneath the fixed-width create tray.
    expect(searchBox!.x + searchBox!.width).toBeLessThan(createTrayBox!.x);

    await shot(page, 'tree', {
      area: 'documents',
      description: 'Documents listing — the seeded document tree',
    });

    const docPath = world?.docPaths?.[0] ?? 'Welcome.md';
    await openTab(page, { kind: 'document', path: docPath });
    const detail = page.getByTestId('document-detail');
    await expect(detail).toBeVisible();
    await shot(page, 'detail', {
      area: 'documents',
      clip: detail,
      selector: '[data-testid=document-detail]',
      description: `Document detail — ${docPath}`,
    });
  });
});

test.describe('history', () => {
  test('timeline', async ({ page }) => {
    await gotoHome(page);
    await openAreaView(page, 'history');
    await expect(page.getByTestId('history-view')).toBeVisible();
    await shot(page, 'timeline', {
      area: 'history',
      description: 'History — global chat/event timeline from the seeded sessions',
    });
  });
});
