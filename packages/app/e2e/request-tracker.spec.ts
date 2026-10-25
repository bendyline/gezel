import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * One request, one tracker, in the real app. Seeds the bakery's project
 * chat as its records stood: the owner asked Dejan for October's invoices
 * (still being drafted, three launch cards in the reply) and then a price
 * list (finished, with a wrap-up). The thread must show one tracker per
 * request, no launch cards, no task cards in the rail, and the price list's
 * file inside its tracker.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';
import { captureScreenshot } from './helpers/screenshot.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');
const SESSION = 'bbbbbbbb-1111-2222-3333-444444444444';

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

// One base for every timestamp: a request is keyed by its task's
// `requestRef.at`, which must equal the person message's `at`. Reading the
// clock per call put them a millisecond apart on slower machines.
const BASE = Date.now() - 30 * 60_000;
function at(minutes: number): string {
  return new Date(BASE + minutes * 60_000).toISOString();
}

async function gezel(home: string, id: string, name: string, role: string): Promise<void> {
  const dir = join(home, 'gezels', id);
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await writeFile(
    join(dir, 'gezel.md'),
    ['---', `id: ${id}`, `name: "${name}"`, `role: "${role}"`, '---', '', 'A gezel.', ''].join(
      '\n',
    ),
  );
}

function card(ref: string, name: string, reused = false) {
  return {
    name: 'invoke_craftbook',
    at: at(1),
    durationMs: 200,
    success: true,
    card: {
      kind: 'craftbook-start',
      craftbookId: 'invoice-run',
      craftbookName: name,
      taskRef: ref,
      projectId: 'bakery',
      status: 'active',
      activeStepId: 'draft',
      steps: [{ id: 'draft', name: 'Draft the invoices', status: 'active' }],
      ...(reused ? { reused: true } : {}),
    },
  };
}

async function seedHome(home: string): Promise<void> {
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({ aiEngagementMode: 'reactive', nightShift: { enabled: false } }),
  );
  await gezel(home, 'dejan', 'Dejan', 'Voorman');
  await gezel(home, 'aditya', 'Aditya', 'Bookkeeper');
  const projectDir = join(home, 'projects', 'bakery');
  await mkdir(join(projectDir, 'tasks', '1'), { recursive: true });
  await mkdir(join(projectDir, 'tasks', '2'), { recursive: true });
  await mkdir(join(projectDir, 'artifacts', 'tasks', '2'), { recursive: true });
  await writeFile(
    join(projectDir, 'project.json'),
    JSON.stringify({
      id: 'bakery',
      name: 'Bakery',
      voormanGezelId: 'dejan',
      gezelIds: ['dejan', 'aditya'],
      createdAt: at(-5),
      updatedAt: at(20),
      nudgeConfig: { enabled: false },
    }),
  );
  await writeFile(join(projectDir, 'artifacts', 'tasks', '2', 'price-list.pdf'), '%PDF-1.4\n');
  await writeFile(join(projectDir, 'tasks', '.next-id'), '3\n');

  const step = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id,
    name,
    createdAt: at(1),
    ...over,
  });
  const task = (num: number, over: Record<string, unknown>) => ({
    projectId: 'bakery',
    num,
    ref: `bakery/${num}`,
    assignee: { kind: 'gezel', gezelId: 'dejan' },
    launchSessionId: SESSION,
    artifactDir: `tasks/${num}`,
    createdBy: { kind: 'user' },
    ...over,
  });
  await writeFile(
    join(projectDir, 'tasks', '1', 'task.json'),
    JSON.stringify(
      task(1, {
        title: 'Invoice run',
        status: 'active',
        activeStepId: 'draft',
        requestRef: { sessionId: SESSION, at: at(0), messageId: 'm1' },
        sourceCraftbookIds: [{ role: 'main', catalogId: 'invoice-run' }],
        craftbook: {
          id: 'invoice-run',
          name: 'Invoice run',
          entryStepId: 'scope',
          createdAt: at(1),
          updatedAt: at(4),
          steps: [
            step('scope', 'Scope the month', { next: 'draft', completedAt: at(3) }),
            step('draft', 'Draft the invoices', {
              next: 'evaluate',
              lastActivatedAt: at(3),
              assignee: { kind: 'gezel', gezelId: 'aditya' },
            }),
            step('evaluate', 'Evaluate', { next: 'finish' }),
            step('finish', 'Finish', { terminal: true }),
          ],
        },
        createdAt: at(1),
        updatedAt: at(4),
      }),
    ),
  );
  await writeFile(
    join(projectDir, 'tasks', '2', 'task.json'),
    JSON.stringify(
      task(2, {
        title: 'Price list',
        status: 'complete',
        requestRef: { sessionId: SESSION, at: at(10), messageId: 'm2' },
        sourceCraftbookIds: [{ role: 'main', catalogId: 'report-pdf' }],
        craftbook: {
          id: 'report-pdf',
          name: 'Formatted Report',
          entryStepId: 'write',
          createdAt: at(11),
          updatedAt: at(19),
          steps: [
            step('write', 'Write the report', {
              next: 'finish',
              completedAt: at(18),
              advanceWhen: { file: 'tasks/2/price-list.pdf', artifact: true },
            }),
            step('finish', 'Finish', { terminal: true, completedAt: at(19) }),
          ],
        },
        createdAt: at(11),
        updatedAt: at(19),
      }),
    ),
  );

  await writeFile(
    join(home, 'gezels', 'dejan', 'sessions', `${SESSION}.json`),
    JSON.stringify({
      version: 1,
      id: SESSION,
      gezelId: 'dejan',
      projectId: 'bakery',
      providerName: 'copilot',
      title: 'October invoices',
      createdAt: at(0),
      lastActivityAt: at(20),
      providerState: {},
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'Make my October invoices for the three cafes',
          at: at(0),
        },
        {
          role: 'assistant',
          content: 'I have started on your invoices.',
          at: at(1),
          toolCalls: [
            card('bakery/1', 'Invoice run'),
            card('bakery/1', 'Invoice run', true),
            card('bakery/1', 'Invoice run', true),
          ],
        },
        { id: 'm2', role: 'user', content: 'And a price list as a PDF, please.', at: at(10) },
        {
          role: 'assistant',
          content: 'Making the price list now.',
          at: at(11),
          toolCalls: [card('bakery/2', 'Formatted Report')],
        },
        {
          role: 'assistant',
          content: 'Your PDF for **Price list** is ready.',
          at: at(20),
          synthetic: 'task-wrapup',
          referencedTasks: ['bakery/2'],
          deliverable: { kind: 'artifact', path: 'tasks/2/price-list.pdf', projectId: 'bakery' },
          makerGezelId: 'aditya',
        },
      ],
    }),
  );
}

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-request-tracker-e2e-'));
  await seedHome(gezelHome);
  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
});

test.afterAll(async () => {
  await closeApp(app);
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('each request is one tracker; the work it stands for stays out of the thread', async () => {
  test.setTimeout(60_000);
  await page.getByTestId('app-sidebar').getByText('Bakery').first().click();
  await expect(page.locator('.chat-timeline').first()).toBeVisible({ timeout: 20_000 });
  const trackers = page.getByTestId('request-tracker');
  await expect(trackers).toHaveCount(2, { timeout: 20_000 });

  const invoices = trackers.filter({ hasText: 'Dejan' }).first();
  await expect(invoices).toBeVisible();
  const prices = page.locator('[data-testid="request-tracker"][data-state="ready"]');
  await expect(prices).toHaveCount(1);
  await expect(prices.locator('.deliverable-card')).toHaveCount(1);
  const working = page.locator('[data-testid="request-tracker"]:not([data-state="ready"])');
  await expect(working).toHaveCount(1);
  await expect(working).toContainText('Making it');

  // What the trackers stand for is not in the thread or the rail.
  await expect(page.locator('.chat-timeline .msg-tool-card')).toHaveCount(0);
  await expect(page.locator('.chat-rail-task')).toHaveCount(0);
  await expect(page.locator('.chat-timeline .deliverable-card')).toHaveCount(1);

  await captureScreenshot(page, {
    path: join(screenshotDir, 'request-tracker-01.png'),
    fullPage: true,
  });
});
