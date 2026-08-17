import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ambientDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ActivityTracker } from '../fs/activity-tracker.js';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { ChromiumNotReadyError } from '../rendering/managed-browser.js';
import {
  AmbientDashboardGenerator,
  type DashboardOneShot,
  extractMarkdown,
} from './dashboard-generator.js';
import type { AmbientDashboardRenderer } from './dashboard-render.js';

let home: string;
let store: Store;
let history: HistoryManager;
let activity: ActivityTracker;
let meesterId: string;
let nowMs: number;

const HOUR = 60 * 60_000;

const DASHBOARD_MD = `---
squisq-dashboard-style: panel
title: The Workshop
---

## Birdhouse breakthrough
The roof went up today.

## Vogelhuis
On track. Next: paint.`;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-ambient-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  activity = new ActivityTracker({ store, history, chatEvents: new ChatEventBus() });
  const meester = await store.createGezel({ name: 'Wren', role: 'Meester' });
  meesterId = meester.id;
  await store.writeConfig({
    meesterGezelId: meesterId,
    ambientDashboard: { enabled: true },
  });
  nowMs = Date.parse('2026-07-18T12:00:00Z');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function fakeRenderer(): ReturnType<typeof vi.fn> {
  return vi.fn(async (opts: Parameters<AmbientDashboardRenderer>[0]) => {
    await writeFile(opts.outputPath, Buffer.from('png-bytes'));
    return { outputPath: opts.outputPath, width: 1920, height: 1080, blocks: 2 };
  });
}

function makeGenerator(
  oneShot: ReturnType<typeof vi.fn>,
  opts: Partial<ConstructorParameters<typeof AmbientDashboardGenerator>[0]> = {},
): AmbientDashboardGenerator {
  return new AmbientDashboardGenerator({
    home,
    store,
    history,
    activity,
    oneShot: oneShot as DashboardOneShot,
    renderer: (opts.renderer ?? fakeRenderer()) as AmbientDashboardRenderer,
    now: () => new Date(nowMs),
    ...opts,
  });
}

async function seedActiveProject(name = 'Vogelhuis'): Promise<string> {
  const project = await store.createProject({ name });
  activity.stamp(project.id, nowMs - HOUR);
  return project.id;
}

/** The generator names files in local time, mirroring `localDay`. */
function expectedFilename(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `dashboard-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
}

describe('extractMarkdown', () => {
  it('accepts a bare document and a fenced one', () => {
    expect(extractMarkdown(DASHBOARD_MD)).toBe(DASHBOARD_MD);
    expect(extractMarkdown(`\`\`\`markdown\n${DASHBOARD_MD}\n\`\`\``)).toBe(DASHBOARD_MD);
    expect(extractMarkdown('   ')).toBeNull();
  });
});

describe('AmbientDashboardGenerator', () => {
  it('generates a dated PNG, latest.png, state, history event, and SSE on sweep', async () => {
    const projectId = await seedActiveProject();
    const oneShot = vi.fn(
      async (_prompt: string, _timeoutMs: number, _opts: { gezelId: string; jobLabel: string }) =>
        DASHBOARD_MD,
    );
    const renderer = fakeRenderer();
    const published: unknown[] = [];
    const gen = makeGenerator(oneShot, {
      renderer: renderer as unknown as AmbientDashboardRenderer,
      events: { publishGlobalEvent: (e) => published.push(e) },
    });

    expect(await gen.sweep()).toBe(true);
    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot.mock.calls[0]?.[2]).toMatchObject({
      gezelId: meesterId,
      jobLabel: 'ambient dashboard',
    });
    expect(oneShot.mock.calls[0]?.[0]).toContain(projectId);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(renderer.mock.calls[0]?.[0]).toMatchObject({
      resolution: 'fhd',
      style: 'panel',
      themeId: 'gezellig',
    });

    const filename = expectedFilename(nowMs);
    const files = await readdir(ambientDir(home));
    expect(files).toContain(filename);
    expect(files).toContain('latest.png');
    expect(await readFile(join(ambientDir(home), 'latest.png'), 'utf8')).toBe('png-bytes');

    const state = await gen.readState();
    expect(state.lastFile).toBe(filename);
    expect(state.inputHash).toBeTruthy();

    const events = await history.listEvents({ kinds: ['meester.dashboard.generated'] });
    expect(events).toHaveLength(1);

    expect(published).toMatchObject([
      { type: 'ambient_dashboard', state: 'started' },
      { type: 'ambient_dashboard', state: 'ended', filename },
    ]);
  });

  it('is opt-in: never runs when the flag is absent or false', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => DASHBOARD_MD);

    await store.writeConfig({ ambientDashboard: null });
    expect(await makeGenerator(oneShot).sweep()).toBe(false);

    await store.writeConfig({ ambientDashboard: { enabled: false } });
    expect(await makeGenerator(oneShot).sweep()).toBe(false);
    expect(oneShot).not.toHaveBeenCalled();
  });

  it('passes the persisted display target and theme to the renderer', async () => {
    await seedActiveProject();
    const displayTarget = {
      width: 3024,
      height: 1964,
      safeArea: { x: 24, y: 100, width: 2976, height: 1840 },
    };
    await store.writeConfig({
      ambientDashboard: { enabled: true, displayTarget, themeId: 'tech-dark' },
    });
    const renderer = fakeRenderer();
    const gen = makeGenerator(
      vi.fn(async () => DASHBOARD_MD),
      {
        renderer: renderer as unknown as AmbientDashboardRenderer,
      },
    );

    expect(await gen.sweep()).toBe(true);
    expect(renderer.mock.calls[0]?.[0]).toMatchObject({ displayTarget, themeId: 'tech-dark' });
  });

  it('skips within the interval throttle and while chat is active; runNow bypasses both', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => DASHBOARD_MD);

    const gen = makeGenerator(oneShot);
    expect(await gen.sweep()).toBe(true);

    activity.stamp((await store.listProjects())[0]!.id, nowMs + 60_000);
    nowMs += 30 * 60_000;
    expect(await gen.sweep()).toBe(false);
    expect(oneShot).toHaveBeenCalledTimes(1);

    const busy = makeGenerator(oneShot, { isChatActive: () => true });
    nowMs += 60 * 60_000;
    expect(await busy.sweep()).toBe(false);
    expect(oneShot).toHaveBeenCalledTimes(1);

    expect(await gen.runNow()).toBe(true);
    expect(oneShot).toHaveBeenCalledTimes(2);
  });

  it('is idempotent on an unchanged workshop', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => DASHBOARD_MD);
    const gen = makeGenerator(oneShot);

    expect(await gen.sweep()).toBe(true);
    nowMs += 2 * 60 * 60_000;
    expect(await gen.sweep()).toBe(false);
    expect(oneShot).toHaveBeenCalledTimes(1);
  });

  it('regenerates when theme or primary-display geometry changes', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => DASHBOARD_MD);
    const renderer = fakeRenderer();
    const gen = makeGenerator(oneShot, {
      renderer: renderer as unknown as AmbientDashboardRenderer,
    });

    expect(await gen.sweep()).toBe(true);

    nowMs += 2 * HOUR;
    await store.writeConfig({
      ambientDashboard: { enabled: true, themeId: 'standard-dark' },
    });
    expect(await gen.sweep()).toBe(true);
    expect(renderer.mock.calls[1]?.[0]).toMatchObject({ themeId: 'standard-dark' });

    nowMs += 2 * HOUR;
    const displayTarget = {
      width: 2560,
      height: 1440,
      safeArea: { x: 24, y: 60, width: 2512, height: 1356 },
    };
    await store.writeConfig({ ambientDashboard: { displayTarget } });
    expect(await gen.sweep()).toBe(true);
    expect(renderer.mock.calls[2]?.[0]).toMatchObject({ displayTarget });
    expect(oneShot).toHaveBeenCalledTimes(3);
  });

  it('skips without consuming state when Chromium is not ready', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => DASHBOARD_MD);
    const renderer = vi.fn(async () => {
      throw new ChromiumNotReadyError('Playwright Chromium is not installed under x.');
    });
    const gen = makeGenerator(oneShot, {
      renderer: renderer as unknown as AmbientDashboardRenderer,
    });

    expect(await gen.sweep()).toBe(false);
    expect(await gen.readState()).toEqual({});

    // Next sweep retries in full — no throttle was recorded.
    expect(await gen.sweep()).toBe(false);
    expect(oneShot).toHaveBeenCalledTimes(2);
  });

  it('advances lastRunAt but preserves inputHash on a render failure', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => DASHBOARD_MD);
    const renderer = vi.fn(async () => {
      throw new Error('boom');
    });
    const gen = makeGenerator(oneShot, {
      renderer: renderer as unknown as AmbientDashboardRenderer,
    });

    expect(await gen.sweep()).toBe(false);
    const state = await gen.readState();
    expect(state.lastRunAt).toBe(new Date(nowMs).toISOString());
    expect(state.inputHash).toBeUndefined();
    expect(state.lastFile).toBeUndefined();
  });

  it('keeps prior dashboard when the model returns nothing usable', async () => {
    await seedActiveProject();
    const renderer = fakeRenderer();
    const oneShot = vi.fn(async () => '');
    const gen = makeGenerator(oneShot, {
      renderer: renderer as unknown as AmbientDashboardRenderer,
    });

    expect(await gen.sweep()).toBe(false);
    expect(renderer).not.toHaveBeenCalled();
    const state = await gen.readState();
    expect(state.lastRunAt).toBeTruthy();
    expect(state.inputHash).toBeUndefined();
  });

  it('prunes dated files beyond keep, never latest.png or applied slots', async () => {
    await seedActiveProject();
    await store.writeConfig({
      meesterGezelId: meesterId,
      ambientDashboard: { enabled: true, keep: 2 },
    });
    const dir = ambientDir(home);
    await mkdir(dir, { recursive: true });
    for (const stamp of ['20260716-0900', '20260717-0900', '20260717-1500']) {
      await writeFile(join(dir, `dashboard-${stamp}.png`), 'old');
    }
    await writeFile(join(dir, 'applied-a.png'), 'slot');
    await writeFile(join(dir, 'stray.png.tmp'), 'tmp');

    const oneShot = vi.fn(async () => DASHBOARD_MD);
    const gen = makeGenerator(oneShot);
    expect(await gen.sweep()).toBe(true);

    const files = (await readdir(dir)).sort();
    expect(files).toContain(expectedFilename(nowMs));
    expect(files).toContain('dashboard-20260717-1500.png');
    expect(files).toContain('applied-a.png');
    expect(files).toContain('latest.png');
    expect(files).not.toContain('dashboard-20260716-0900.png');
    expect(files).not.toContain('dashboard-20260717-0900.png');
    expect(files).not.toContain('stray.png.tmp');
  });

  it('excludes its own and the status generator events from the input hash', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => DASHBOARD_MD);
    const gen = makeGenerator(oneShot);
    expect(await gen.sweep()).toBe(true);

    await history.log({
      kind: 'meester.dashboard.generated',
      gezelId: meesterId,
      summary: 'Ambient dashboard generated',
    });
    await history.log({
      kind: 'meester.status.generated',
      gezelId: meesterId,
      summary: 'Meester status report generated',
    });
    nowMs += 2 * 60 * 60_000;
    expect(await gen.sweep()).toBe(false);
    expect(oneShot).toHaveBeenCalledTimes(1);
  });

  it('gates automatic runs on engagement mode; night shift opens scheduled mode', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => DASHBOARD_MD);

    await store.writeConfig({
      meesterGezelId: meesterId,
      ambientDashboard: { enabled: true },
      aiEngagementMode: 'scheduled',
    });
    expect(await makeGenerator(oneShot).sweep()).toBe(false);
    expect(await makeGenerator(oneShot, { isNightShiftActive: () => true }).sweep()).toBe(true);
  });
});
