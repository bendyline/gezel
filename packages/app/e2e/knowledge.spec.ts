import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Knowledge catalogs, end to end (WS-I exit flow): build a real `.gezk`,
 * install it through Settings → Knowledge, watch the sidebar area appear
 * exactly when the first catalog registers, browse the shipped TOC to a
 * document, copy a citation, disable the catalog (area disappears), and
 * remove it. Then the gilde flow: the same archive pinned by a
 * `knowledge-catalog` entry in a fixture gilde data dir, served by a local
 * stand-in for Hugging Face, downloaded from the Knowledge section's catalog
 * browser and removed again.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';
import { captureScreenshot } from './helpers/screenshot.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');
const UI_LOAD_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = UI_LOAD_TIMEOUT_MS + 60_000;
const GILDE_REVISION = 'a'.repeat(40);
const GILDE_REPO = 'Bendyline/shop-notes';
const GILDE_PATH = 'releases/1.0.0/shop-notes-1.0.0.gezk';

/**
 * A gilde data dir for the driven app: the pinned content plus one
 * `knowledge-catalog` entry whose sha256 and size are the fixture archive's.
 */
function pinnedGildeDataDir(): string {
  // The app depends on the service, the service on the catalog loader, and
  // the loader on the pinned gilde package — follow that chain through the
  // workspace's node_modules links instead of adding a test-only dependency
  // (the loader is ESM-only, so require-based resolution cannot enter it).
  const fromApp = createRequire(import.meta.url);
  const serviceRoot = dirname(fromApp.resolve('@bendyline/gezel-service/package.json'));
  const catalogRoot = join(serviceRoot, 'node_modules', '@bendyline', 'gezel-catalog');
  return join(catalogRoot, 'node_modules', '@bendyline', 'gilde', 'data');
}

async function buildGildeData(root: string, archivePath: string): Promise<void> {
  await cp(pinnedGildeDataDir(), root, { recursive: true });
  const bytes = await readFile(archivePath);
  const itemDir = join(root, 'knowledge-catalogs', 'sh', 'shop-notes');
  await mkdir(join(itemDir, 'versions', '1.0.0'), { recursive: true });
  await writeFile(
    join(itemDir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'knowledge-catalog',
      id: 'shop-notes',
      name: 'Shop Notes',
      description: 'Workshop reference for the e2e flow.',
      tags: ['workshop'],
      maintainer: { name: 'Gezel E2E' },
      license: 'MIT',
      licenseClass: 'open',
      publisherId: 'gezel-e2e',
      language: 'en',
      category: 'manuals',
      yankedVersions: [],
    }),
  );
  await writeFile(
    join(itemDir, 'versions', '1.0.0', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-09-01T00:00:00.000Z',
      formatVersion: '0.5',
      huggingface: { repo: GILDE_REPO, revision: GILDE_REVISION, path: GILDE_PATH },
      sha256: createHash('sha256').update(bytes).digest('hex'),
      archiveBytes: bytes.length,
      uncompressedBytes: bytes.length * 2,
      documents: 2,
      chunks: 2,
      embeddingProfile: { id: 'bge-small-en-v1.5@1', modelRepo: 'Xenova/bge-small-en-v1.5' },
      topics: [
        { id: 'joinery', name: 'Joinery' },
        { id: 'finishing', name: 'Finishing' },
      ],
    }),
  );
}

/** Serves the fixture archive at the commit-pinned resolve path. */
async function serveArchive(archivePath: string): Promise<{ server: Server; baseUrl: string }> {
  const bytes = await readFile(archivePath);
  const expected = `/datasets/${GILDE_REPO}/resolve/${GILDE_REVISION}/${GILDE_PATH}`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== expected) {
      res.writeHead(404);
      res.end();
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const from = range ? Number.parseInt(range[1] as string, 10) : 0;
    res.writeHead(from > 0 ? 206 : 200, {
      'content-type': 'application/zip',
      'content-length': String(bytes.length - from),
      ...(from > 0 ? { 'content-range': `bytes ${from}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    res.end(bytes.subarray(from));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

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
      id: 'test-hash-embed@1',
      model: { repo: 'test/hash-embed', revision: 'fixture' },
      tokenizer: { kind: 'whitespace' },
      pooling: 'mean',
      normalized: true,
      dimensions: 384,
      maxTokens: 512,
      queryInstruction: '',
      passageInstruction: '',
      vectorEncoding: 'bit+int8',
      distance: { stage1: 'hamming', stage2: 'cosine' },
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
      },
    },
    chunkingProfile: {
      id: 'markdown-chunks@2',
      unit: 'tokens',
      tokenizer: 'profile',
      target: 420,
      overlap: 64,
      contextHeader: { max: 64 },
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
  let gildeData: string;
  let hub: { server: Server; baseUrl: string };
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    // The hook builds a real .gezk plus a gilde data dir before it ever
    // launches Electron, so the suite-wide 30s default is not a lifecycle
    // budget — it is barely the archive.
    test.setTimeout(HOOK_TIMEOUT_MS);
    home = await mkdtemp(join(tmpdir(), 'gezel-knowledge-e2e-'));
    assets = await mkdtemp(join(tmpdir(), 'gezel-knowledge-e2e-assets-'));
    archivePath = join(assets, 'shop-notes-1.0.0.gezk');
    await buildCatalog(archivePath, join(assets, 'work'));
    gildeData = join(assets, 'gilde-data');
    await buildGildeData(gildeData, archivePath);
    hub = await serveArchive(archivePath);
    app = await electron.launch({
      args: [appRoot],
      env: buildLaunchEnv({
        GEZEL_HOME: home,
        GEZEL_MOCK_PROVIDER: '1',
        GEZEL_EMBEDDED: '1',
        GEZEL_GILDE_DATA_DIR: gildeData,
        GEZEL_HF_BASE_URL: hub.baseUrl,
      }),
    });
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('sidebar-area-settings')).toBeVisible({
      timeout: UI_LOAD_TIMEOUT_MS,
    });
  });

  test.afterAll(async () => {
    await closeApp(app);
    hub?.server.close();
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
    await captureScreenshot(page, {
      path: join(screenshotDir, 'knowledge-settings.png'),
      fullPage: true,
    });

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
    await captureScreenshot(page, {
      path: join(screenshotDir, 'knowledge-browser.png'),
      fullPage: true,
    });

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

  test('download from the catalog → installed → remove', async () => {
    await page.getByTestId('sidebar-area-settings').click();
    await page.getByTestId('settings-nav-knowledge').click();
    await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();

    // The gilde entry renders as a catalog card with its Hugging Face link.
    const card = page.locator('.catalog-item', { hasText: 'Shop Notes' });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTitle(`View ${GILDE_REPO} on Hugging Face`)).toHaveAttribute(
      'href',
      `https://huggingface.co/datasets/${GILDE_REPO}`,
    );
    await card.getByRole('button', { name: 'Download', exact: true }).click();

    // The download lands in the installed table, active and private.
    const row = page.getByTestId('knowledge-catalog-shop-notes');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText(/^active/)).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('Only for you')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Installed' })).toBeDisabled({ timeout: 10_000 });
    await expect(page.getByTestId('sidebar-area-knowledge')).toBeVisible({ timeout: 10_000 });
    await captureScreenshot(page, screenshotDir, 'knowledge-catalog-downloaded');

    // Remove: the card offers Download again, and the area disappears.
    await row.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('button', { name: 'Remove catalog' }).click();
    await expect(page.getByText('Nothing installed yet', { exact: false })).toBeVisible({
      timeout: 10_000,
    });
    await expect(card.getByRole('button', { name: 'Download', exact: true })).toBeEnabled({
      timeout: 10_000,
    });
    await expect(page.getByTestId('sidebar-area-knowledge')).toHaveCount(0, { timeout: 10_000 });
  });
});
