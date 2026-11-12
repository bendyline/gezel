/**
 * UI responsiveness at scale, measured rather than asserted. Each run writes
 * `test-results/ui-perf.json` so a change can be compared with the run before
 * it. Nothing here fails on a number: timing on shared machines is noisy, and
 * tight gates on it only teach people to rerun. Run with
 * `pnpm --filter @bendyline/gezel-app run test:perf` after `pnpm build`.
 *
 * Scenarios: Home cold and warm; a route through a project with a
 * 2,000-message timeline and back (navigation timing from the app's own
 * reports); streaming a 20 KB reply into that timeline; scrolling it; and the
 * renderer's CPU while nothing happens.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GezelClient } from '@bendyline/gezel-client';
import type { Page } from '@playwright/test';
import { test as base, expect } from '../e2e-web/fixtures/test.js';
import { openProject } from '../e2e-web/helpers/nav.js';
import {
  type FrameStats,
  type NavigationReport,
  collectNavigationReports,
  idleCpu,
  installPageProbes,
  median,
  pageNow,
  readMarks,
  startFrameClock,
  startProfile,
  timedMove,
  topShifts,
  traceMainThread,
} from './helpers/probes.js';
import { type ScaleWorld, seedScale } from './helpers/seed-scale.js';

const test = base.extend({
  // The web suite attaches a debugger to every page for hang diagnosis, which
  // changes how V8 runs the page. Timing runs go without it. An override keeps
  // the fixture's own options, so it stays automatic.
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
  browserDiagnostics: async ({}, use) => {
    await use(undefined);
  },
});

test.use({ daemonGroup: 'perf' });
test.describe.configure({ mode: 'serial' });

const RUNS = Math.max(1, Number(process.env.GEZEL_PERF_RUNS ?? '3') || 3);
const OUT =
  process.env.GEZEL_PERF_OUT ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'ui-perf.json');

let scale: ScaleWorld | null = null;
const results: Record<string, unknown> = {};

test.beforeAll(async ({ daemon }) => {
  test.setTimeout(240_000);
  if (!daemon.world) throw new Error('the perf suite needs the seeded world');
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  scale = await seedScale(client, daemon.home, daemon.world);
  results.world = {
    projects: scale.projectCount,
    gezels: scale.gezelCount,
    sessions: scale.sessionCount,
    bigProjectMessages: scale.messageCount,
  };
});

test.afterAll(async () => {
  await mkdir(dirname(OUT), { recursive: true });
  const report = { at: new Date().toISOString(), runs: RUNS, ...results };
  await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[ui-perf] wrote ${OUT}`);
});

test.beforeEach(async ({ context }) => {
  await installPageProbes(context);
});

async function scriptBytes(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const scripts = performance
      .getEntriesByType('resource')
      .filter((entry) =>
        new URL(entry.name).pathname.endsWith('.js'),
      ) as PerformanceResourceTiming[];
    const fonts = performance
      .getEntriesByType('resource')
      .filter((entry) =>
        new URL(entry.name).pathname.endsWith('.woff2'),
      ) as PerformanceResourceTiming[];
    return {
      files: scripts.length,
      decodedBytes: scripts.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
      transferredBytes: scripts.reduce((sum, entry) => sum + entry.transferSize, 0),
      fonts: fonts.map((entry) => ({
        file: new URL(entry.name).pathname.split('/').pop(),
        bytes: entry.decodedBodySize,
      })),
    };
  });
}

/**
 * Recently visited views stay mounted but hidden (KeepAliveHost), so a test id
 * can match the shown view and a kept one. Act on the one on screen.
 */
function visibleTestId(page: Page, id: string) {
  return page.getByTestId(id).filter({ visible: true });
}

test('Home, cold and warm', async ({ page }) => {
  const loads: Record<string, unknown>[] = [];
  for (const kind of ['cold', 'warm'] as const) {
    if (kind === 'cold') await page.goto('/');
    else await page.reload();
    await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-testid="chat-composer"] [contenteditable="true"]').first(),
    ).toBeAttached({
      timeout: 30_000,
    });
    await page.waitForTimeout(1_000);
    const marks = await readMarks(page);
    const nav = await page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return { domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd) };
    });
    loads.push({
      kind,
      ...nav,
      homeWorkshopMs: Math.round(marks.homeWorkshop ?? -1),
      composerEditableMs: Math.round(marks.composerEditable ?? -1),
      scripts: await scriptBytes(page),
    });
  }
  results.home = loads;
});

test('navigation route through a large project', async ({ page }) => {
  test.setTimeout(300_000);
  const big = scale!.bigProjectId;
  const other = scale!.otherProjectId;
  const reports = collectNavigationReports(page);
  await page.goto('/');
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);

  const steps: { name: string; act: () => Promise<void> }[] = [
    { name: 'open large project', act: () => openProject(page, big) },
    { name: 'project tab: tasks', act: () => visibleTestId(page, 'project-tab-tasks').click() },
    { name: 'project tab: chat', act: () => visibleTestId(page, 'project-tab-chat').click() },
    { name: 'open second project', act: () => openProject(page, other) },
    {
      name: 'back to large project',
      act: () => page.getByRole('button', { name: /^Back/ }).first().click(),
    },
    { name: 'open settings', act: () => page.getByTestId('sidebar-area-settings').click() },
    { name: 'open home', act: () => page.getByTestId('sidebar-meester').click() },
  ];

  const byStep = new Map<string, NavigationReport[]>();
  const shiftsByStep = new Map<string, { node: string; value: number }[]>();
  for (let run = 0; run < RUNS; run++) {
    for (const step of steps) {
      const since = await pageNow(page);
      const report = await timedMove(page, reports, step.act);
      if (!report) {
        console.log(`[ui-perf] no navigation report for "${step.name}" (run ${run + 1})`);
        continue;
      }
      byStep.set(step.name, [...(byStep.get(step.name) ?? []), report]);
      if (run === RUNS - 1) shiftsByStep.set(step.name, await topShifts(page, since));
    }
  }

  results.navigation = steps.map((step) => {
    const runs = byStep.get(step.name) ?? [];
    const pick = (field: keyof NavigationReport) =>
      runs.map((r) => r[field]).filter((v): v is number => typeof v === 'number');
    const first = runs[0];
    return {
      step: step.name,
      runs: runs.length,
      firstRun: first
        ? {
            settledMs: first.settledMs,
            paintedMs: first.paintedMs,
            contentMs: first.contentMs,
            requests: first.requests,
          }
        : null,
      median: {
        firstFrameMs: median(pick('firstFrameMs')),
        settledMs: median(pick('settledMs')),
        paintedMs: median(pick('paintedMs')),
        contentMs: median(pick('contentMs')),
        layoutShift: Math.max(0, ...pick('layoutShift')),
        requests: median(pick('requests')),
        backgroundRequests: median(pick('backgroundRequests')),
        longFrameMaxMs: median(runs.map((r) => r.longTasks.maxMs)),
      },
      slowest: first?.slowest.slice(0, 3) ?? [],
      shiftedMost: shiftsByStep.get(step.name) ?? [],
    };
  });
});

test('streaming a long reply into a 2,000-message timeline', async ({ page, daemon }) => {
  test.setTimeout(300_000);
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  await page.goto('/');
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 30_000 });
  await openProject(page, scale!.bigProjectId);
  const timeline = page.locator('.project-chat').getByTestId('chat-timeline');
  await expect(timeline).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await page.waitForTimeout(1_000);

  const paragraph =
    'Streaming paragraph with **bold**, `code`, and a [link](https://example.com). The reply keeps growing so every frame re-renders its tail.\n\n';
  const prompt = `Perf stream\n\n${paragraph.repeat(Math.ceil(20_000 / paragraph.length))}`;
  process.env.GEZEL_MOCK_STREAM_CHUNK_CHARS = '24';
  process.env.GEZEL_MOCK_STREAM_INTERVAL_MS = '16';
  try {
    const before = (await client.getChatSession(scale!.streamSessionId)).messages.length;
    const profiler = process.env.GEZEL_PERF_PROFILE === '1' ? await startProfile(page) : null;
    const stop = await startFrameClock(page);
    const started = Date.now();
    await client.sendToChatSession(scale!.streamSessionId, prompt);
    if (profiler) {
      await page.waitForTimeout(6_000);
      results.streamingProfile = await profiler(test.info().outputPath('streaming.cpuprofile'));
      results.streamingTrace = await traceMainThread(page, 4_000);
    }
    await expect
      .poll(async () => (await client.getChatSession(scale!.streamSessionId)).messages.length, {
        timeout: 240_000,
        intervals: [500],
      })
      .toBeGreaterThanOrEqual(before + 2);
    const frames = await stop();
    results.streaming = {
      replyChars: prompt.length,
      durationMs: Date.now() - started,
      frames,
      domNodes: await page.evaluate(() => document.getElementsByTagName('*').length),
    };
  } finally {
    delete process.env.GEZEL_MOCK_STREAM_CHUNK_CHARS;
    delete process.env.GEZEL_MOCK_STREAM_INTERVAL_MS;
  }
});

test('scrolling back through a long timeline', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 30_000 });
  await openProject(page, scale!.bigProjectId);
  const timeline = page.locator('.project-chat').getByTestId('chat-timeline');
  await expect(timeline).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await page.waitForTimeout(1_000);
  const box = await timeline.boundingBox();
  if (!box) throw new Error('timeline has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const rowsBefore = await timeline.locator('[data-msg-id]').count();
  const stop = await startFrameClock(page);
  for (let i = 0; i < 120; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(500);
  const frames: FrameStats = await stop();
  results.scrolling = {
    wheelSteps: 120,
    rowsBefore,
    rowsAfter: await timeline.locator('[data-msg-id]').count(),
    frames,
  };
});

test('renderer CPU while idle', async ({ page }) => {
  test.setTimeout(120_000);
  const cdp = await page.context().newCDPSession(page);
  await page.goto('/');
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const homeCpuSeconds = await idleCpu(page, cdp, 10_000);
  await openProject(page, scale!.bigProjectId);
  await expect(page.locator('.project-chat').getByTestId('chat-timeline')).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 60_000 },
  );
  await page.waitForTimeout(2_000);
  const projectChatCpuSeconds = await idleCpu(page, cdp, 10_000);
  results.idle = { windowMs: 10_000, homeCpuSeconds, projectChatCpuSeconds };
  await cdp.detach();
});
