import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Prompt drafts E2E — the promise the feature actually makes: a message you
 * started writing is still there after the app has been closed and reopened.
 * Everything else about drafts is covered by unit tests; this is the one
 * claim that only a real restart can prove.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(_dirname, '..');

let gezelHome: string;

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-prompt-drafts-e2e-'));
});

test.afterAll(async () => {
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
      GEZEL_DISABLE_MEMORY_EXTRACTION: '1',
    }),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const brand = page.locator('.app-header-brand');
  await expect(brand).toBeVisible({ timeout: 20_000 });
  await brand.click();
  await expect(page.locator('.squisq-wysiwyg-editor').first()).toBeVisible({ timeout: 20_000 });
  return { app, page };
}

const DRAFT_TEXT = 'a prompt I want to finish tomorrow';

const promptsDir = () => join(gezelHome, 'projects', 'default', 'artifacts', 'prompts');

/** The text of the single draft on disk, or '' while none has been written. */
async function draftText(): Promise<string> {
  const folders = await readdir(promptsDir()).catch(() => [] as string[]);
  const folder = folders[0];
  if (!folder) return '';
  return await readFile(join(promptsDir(), folder, 'message.md'), 'utf8').catch(() => '');
}

test('prompt drafts — an unsent message survives closing the app', async () => {
  // Two full Electron lifecycles, like the sessions spec.
  test.setTimeout(150_000);

  {
    const { app, page } = await launch();
    try {
      const editor = page.locator('.squisq-wysiwyg-editor').first();
      await editor.click();
      await page.keyboard.type(DRAFT_TEXT);
      // The composer's autosave status is failures-only by design, so there
      // is nothing on screen to wait for. Wait on the file instead — it is
      // what the feature promises, and it outlives the window.
      await expect.poll(() => draftText(), { timeout: 20_000 }).toContain(DRAFT_TEXT);
    } finally {
      await closeApp(app);
    }
  }

  // The draft is a real file, not just something the renderer remembered.
  const draftFolders = await readdir(promptsDir());
  expect(draftFolders.length).toBeGreaterThan(0);
  expect(draftFolders[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
  expect(await readdir(join(promptsDir(), draftFolders[0] as string))).toEqual(
    expect.arrayContaining(['draft.json', 'message.md', 'message_files']),
  );

  {
    const { app, page } = await launch();
    try {
      const editor = page.locator('.squisq-wysiwyg-editor').first();
      await expect(editor).toContainText(DRAFT_TEXT, { timeout: 20_000 });
    } finally {
      await closeApp(app);
    }
  }
});
