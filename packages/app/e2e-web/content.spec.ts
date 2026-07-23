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
    await shot(page, 'list', {
      area: 'craftbooks',
      description: 'Craftbooks gallery — My craftbooks / Project / Gilde catalog',
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
