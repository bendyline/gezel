import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GezelClient } from '@bendyline/gezel-client';
import { expect, test } from './fixtures/test.js';
import { gotoHome, openAreaView, openProject, openTask } from './helpers/nav.js';

test.use({ daemonGroup: 'performance' });

test('a real task editor becomes idle and saves an edit across navigation', async ({
  page,
  daemon,
  world,
}) => {
  test.skip(!world, 'requires the seeded world');
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  await gotoHome(page);
  await openTask(page, world!.taskRefs[0]!);
  const editor = page.locator('.task-description-editor [contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  await page.waitForTimeout(1_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const cpu = async () =>
    (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')!
      .value;
  const before = await cpu();
  await page.waitForTimeout(2_000);
  // A sustained render loop consumed ~2 CPU seconds in this window even
  // without a single long task. Leave ample headroom for shared CI hosts.
  expect((await cpu()) - before).toBeLessThan(1.3);
  await editor.fill('Performance regression: keep this description');
  await openAreaView(page, 'settings');
  await expect
    .poll(async () => (await client.getTaskByRef(world!.taskRefs[0]!)).description)
    .toContain('Performance regression: keep this description');
  await openTask(page, world!.taskRefs[0]!);
  await expect(editor).toContainText('Performance regression: keep this description');
  await cdp.detach();
});

test('hundreds of plain messages share attachment reads, including on older pages', async ({
  page,
  daemon,
  world,
}) => {
  test.skip(!world, 'requires the seeded world');
  const path = join(
    daemon.home,
    'gezels',
    world!.gezelIds.ada,
    'sessions',
    `${world!.sessionId}.json`,
  );
  const original = await readFile(path, 'utf8');
  const session = JSON.parse(original);
  session.messages = Array.from({ length: 300 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `Performance message ${i}`,
    at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
    referencedFiles: [],
    referencedTasks: [],
  }));
  let attachmentReads = 0;
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname === `/api/projects/${world!.projectId}/attachments` &&
      request.method() === 'GET'
    )
      attachmentReads++;
  });
  try {
    await writeFile(path, JSON.stringify(session));
    await gotoHome(page);
    attachmentReads = 0;
    await openProject(page, world!.projectId);
    await expect(page.getByText('Performance message 299', { exact: true })).toBeAttached();
    await page.waitForTimeout(500);
    expect(attachmentReads).toBeLessThanOrEqual(2);
    await page.getByTestId('chat-timeline').evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByText('Performance message 150', { exact: true })).toBeAttached();
    expect(attachmentReads).toBeLessThanOrEqual(3);
  } finally {
    await writeFile(path, original);
  }
});

test('the first usable Home stays within its actual JavaScript budget', async ({ page }) => {
  await gotoHome(page);
  await expect(page.locator('[contenteditable="true"]').first()).toBeAttached();
  await page.waitForTimeout(1_000);
  const bytes = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((entry) => new URL(entry.name).pathname.endsWith('.js'))
      .reduce((sum, entry) => sum + (entry as PerformanceResourceTiming).decodedBodySize, 0),
  );
  // Includes immediately lazy-loaded Home/composer dependencies which the
  // HTML modulepreload budget cannot see. Baseline was 5.59 MiB decoded.
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThan(6.2 * 1024 * 1024);
});
