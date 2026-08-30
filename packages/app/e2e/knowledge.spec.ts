import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Knowledge catalogs, end to end (WS-I exit flow): build a real `.gezk`,
 * install it through Settings → Knowledge, watch the sidebar area appear
 * exactly when the first catalog registers, browse the shipped TOC to a
 * document, copy a citation, disable the catalog (area disappears), and
 * remove it.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');

function testHashVector(text: string): number[] {
  const dims = 384;
  const out = new Array<number>(dims);
  let hash = createHash('sha256').update(text, 'utf8').digest();
  let offset = 0;
  for (let i = 0; i < dims; i++) {
    if (offset >= hash.length) {
      hash = createHash('sha256').update(hash).digest();
      offset = 0;
    }
    out[i] = ((hash.readInt8(offset) ?? 0) + 0.5) / 128;
    offset++;
  }
  return out;
}

async function buildCatalog(outputPath: string, workDir: string): Promise<void> {
  const { compileKnowledgeCatalog } = await import('@bendyline/gezel-knowledge');
  await compileKnowledgeCatalog({
    catalog: {
      id: 'shop-notes',
      version: '1.0.0',
      name: 'Shop Notes',
      description: 'Workshop reference for the e2e flow.',
      language: 'en',
      publisher: { id: 'gezel-e2e', name: 'Gezel E2E' },
      createdAt: '2026-01-01T00:00:00.000Z',
      license: { name: 'MIT', attributionRequired: false },
    },
    topics: [
      { id: 'joinery', name: 'Joinery' },
      { id: 'finishing', name: 'Finishing' },
    ],
    documents: (async function* () {
      yield {
        id: 'dovetails',
        title: 'Dovetail Joints',
        slug: 'dovetails',
        summary: 'Interlocking corner joinery.',
        language: 'en',
        topicPath: ['joinery'],
        markdown: '# Dovetail Joints\n\nTails and pins interlock for a strong corner.\n',
      };
      yield {
        id: 'shellac',
        title: 'Shellac',
        slug: 'shellac',
        summary: 'A natural resin finish.',
        language: 'en',
        topicPath: ['finishing'],
        markdown: '# Shellac\n\nShellac dries fast and repairs easily.\n',
      };
    })(),
    outputPath,
    embeddingProfile: {
      id: 'gezel-test-hash-embed@1',
      model: { repo: 'test/hash-embed', revision: 'fixture' },
      tokenizer: { kind: 'whitespace' },
      pooling: 'mean',
      normalized: true,
      dimensions: 384,
      maxTokens: 512,
      queryInstruction: '',
      passageInstruction: '',
      vectorEncoding: 'bit384+int8',
      distance: { stage1: 'hamming', stage2: 'cosine' },
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
      },
    },
    chunkingProfile: {
      id: 'gezel-markdown-chunks@2',
      unit: 'tokens',
      tokenizer: 'profile',
      targetTokens: 420,
      overlapTokens: 64,
      contextHeader: { maxTokens: 64 },
    },
    embed: async (texts) => texts.map(testHashVector),
    countTokens: (text) => (text.trim() ? text.trim().split(/\s+/).length : 0),
    workDir,
  });
}

test.describe('Knowledge catalogs', () => {
  let home: string;
  let assets: string;
  let archivePath: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-knowledge-e2e-'));
    assets = await mkdtemp(join(tmpdir(), 'gezel-knowledge-e2e-assets-'));
    archivePath = join(assets, 'shop-notes-1.0.0.gezk');
    await buildCatalog(archivePath, join(assets, 'work'));
    app = await electron.launch({
      args: [appRoot],
      env: buildLaunchEnv({
        GEZEL_HOME: home,
        GEZEL_MOCK_PROVIDER: '1',
        GEZEL_EMBEDDED: '1',
      }),
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('sidebar-area-settings')).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    await closeApp(app);
    await rm(home, { recursive: true, force: true }).catch(() => {});
    await rm(assets, { recursive: true, force: true }).catch(() => {});
  });

  test('install → area appears → browse → cite → disable → remove', async () => {
    // The area is hidden while no catalog is registered.
    await expect(page.getByTestId('sidebar-area-knowledge')).toHaveCount(0);

    // Install through Settings → Knowledge (typed path — no native dialog
    // in a driven session).
    await page.getByTestId('sidebar-area-settings').click();
    const navItem = page.getByTestId('settings-nav-knowledge');
    await expect(navItem).toBeVisible({ timeout: 10_000 });
    await navItem.click();
    await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();

    await page.getByLabel('Catalog file path or URL').fill(archivePath);
    await page.getByRole('button', { name: 'Install', exact: true }).click();

    await expect(page.getByText('Shop Notes')).toBeVisible({ timeout: 30_000 });
    // The fixture's hash-embed profile is not the daemon's embedder, so the
    // honest state is keyword-only — still active.
    await expect(page.getByText(/^active/)).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: join(screenshotDir, 'knowledge-settings.png'), fullPage: true });

    // The sidebar area flips on at registered-count ≥ 1.
    await expect(page.getByTestId('sidebar-area-knowledge')).toBeVisible({ timeout: 10_000 });

    // Browse: TOC → topic → document → provenance actions.
    await page.getByTestId('sidebar-area-knowledge').click();
    await expect(page.getByTestId('knowledge-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Joinery/ })).toBeVisible();
    await page.getByRole('button', { name: /Dovetail Joints/ }).click();
    await expect(page.locator('.knowledge-reader-header h2')).toHaveText('Dovetail Joints', {
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Copy citation' })).toBeVisible();
    await page.getByRole('button', { name: 'Copy citation' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    await page.screenshot({ path: join(screenshotDir, 'knowledge-browser.png'), fullPage: true });

    // Disable: the catalog stays REGISTERED, so the area stays in the rail
    // (visibility flips at registered-count ≥ 1, not enabled-count) — the
    // state line just reads disabled.
    await page.getByTestId('sidebar-area-settings').click();
    await page.getByTestId('settings-nav-knowledge').click();
    // The checkbox is controlled: its state lands after the daemon round
    // trip, so click + polled assertion rather than uncheck()'s immediate
    // post-click verification.
    const enabledToggle = page.getByTestId('knowledge-catalog-shop-notes').getByRole('checkbox');
    await enabledToggle.click();
    await expect(enabledToggle).not.toBeChecked({ timeout: 10_000 });
    await expect(page.getByText('disabled', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('sidebar-area-knowledge')).toBeVisible();

    // Remove: the registration goes away, and with it the sidebar area.
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('button', { name: 'Remove catalog' }).click();
    await expect(page.getByText('Nothing installed yet', { exact: false })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('sidebar-area-knowledge')).toHaveCount(0, { timeout: 10_000 });
  });
});
