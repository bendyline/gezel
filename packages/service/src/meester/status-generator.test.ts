import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ActivityTracker } from '../fs/activity-tracker.js';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from '../tasks/manager.js';
import { MeesterStatusGenerator, type StatusOneShot, localDay } from './status-generator.js';

let home: string;
let store: Store;
let history: HistoryManager;
let tasks: TaskManager;
let activity: ActivityTracker;
let meesterId: string;
let nowMs: number;

const HOUR = 60 * 60_000;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-status-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  tasks = new TaskManager(store, history);
  activity = new ActivityTracker({ store, history, chatEvents: new ChatEventBus() });
  const meester = await store.createGezel({ name: 'Wren', role: 'Meester' });
  meesterId = meester.id;
  await store.writeConfig({ meesterGezelId: meesterId });
  nowMs = Date.parse('2026-07-18T12:00:00Z');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function modelOutput(overrides: Record<string, unknown> = {}): string {
  const body = {
    headline: 'Your birdhouse is nearly done! Click to see it!',
    report: '## Vogelhuis\nThe roof went up today.',
    ...overrides,
  };
  return `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;
}

function makeGenerator(
  oneShot: ReturnType<typeof vi.fn>,
  opts: Partial<ConstructorParameters<typeof MeesterStatusGenerator>[0]> = {},
): MeesterStatusGenerator {
  return new MeesterStatusGenerator({
    store,
    history,
    tasks,
    activity,
    oneShot: oneShot as StatusOneShot,
    now: () => new Date(nowMs),
    ...opts,
  });
}

async function seedActiveProject(name = 'Vogelhuis'): Promise<string> {
  const project = await store.createProject({ name });
  activity.stamp(project.id, nowMs - HOUR);
  return project.id;
}

describe('localDay', () => {
  it('formats the local calendar day', () => {
    const d = new Date(2026, 6, 18, 23, 30);
    expect(localDay(d)).toBe('2026-07-18');
  });
});

describe('MeesterStatusGenerator', () => {
  it('generates a report, headline, and history event on an auto sweep', async () => {
    const projectId = await seedActiveProject();
    const oneShot = vi.fn(
      async (_prompt: string, _timeoutMs: number, _opts: { gezelId: string; jobLabel: string }) =>
        modelOutput(),
    );
    const gen = makeGenerator(oneShot);

    expect(await gen.sweep()).toBe(true);
    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot.mock.calls[0]?.[2]).toMatchObject({ gezelId: meesterId });
    expect(oneShot.mock.calls[0]?.[0]).toContain(projectId);

    const report = await store.readMeesterStatus();
    expect(report?.headline).toBe('Your birdhouse is nearly done! Click to see it!');
    expect(report?.trigger).toBe('auto');
    expect(report?.report).toContain('The roof went up');

    const events = await history.listEvents({ kinds: ['meester.status.generated'] });
    expect(events).toHaveLength(1);

    const state = await store.readMeesterStatusState();
    expect(state.runsOnDay).toBe(1);
    expect(state.runDay).toBe(localDay(new Date(nowMs)));
  });

  it('skips when disabled or when no meester is designated', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => modelOutput());

    await store.writeConfig({ meesterStatus: { enabled: false } });
    expect(await makeGenerator(oneShot).sweep()).toBe(false);

    await store.writeConfig({ meesterStatus: { enabled: true }, meesterGezelId: undefined });
    expect(await makeGenerator(oneShot).sweep()).toBe(false);
    expect(oneShot).not.toHaveBeenCalled();
  });

  it('gates automatic runs on engagement mode, with night shift opening scheduled mode', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => modelOutput());

    await store.writeConfig({ aiEngagementMode: 'reactive' });
    expect(await makeGenerator(oneShot).sweep()).toBe(false);

    await store.writeConfig({ aiEngagementMode: 'scheduled' });
    expect(await makeGenerator(oneShot).sweep()).toBe(false);
    expect(await makeGenerator(oneShot, { isNightShiftActive: () => true }).sweep()).toBe(true);
    expect(oneShot).toHaveBeenCalledTimes(1);
  });

  it('never runs automatically while a chat turn is in flight or the user is active', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => modelOutput());
    expect(await makeGenerator(oneShot, { isChatActive: () => true }).sweep()).toBe(false);
    expect(await makeGenerator(oneShot, { osIdleSeconds: () => 30 }).sweep()).toBe(false);
    expect(oneShot).not.toHaveBeenCalled();
  });

  it('enforces the daily budget and the minimum gap between runs', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => modelOutput());
    const day = localDay(new Date(nowMs));

    await store.writeMeesterStatusState({ runDay: day, runsOnDay: 4 });
    expect(await makeGenerator(oneShot).sweep()).toBe(false);

    await store.writeMeesterStatusState({
      runDay: day,
      runsOnDay: 1,
      lastRunAt: new Date(nowMs - HOUR).toISOString(),
    });
    expect(await makeGenerator(oneShot).sweep()).toBe(false);
    expect(oneShot).not.toHaveBeenCalled();

    // Day rollover resets the budget (and the stale stamp is refreshed).
    nowMs += 24 * HOUR;
    const projectId = (await store.listProjects())[0]?.id ?? '';
    activity.stamp(projectId, nowMs - HOUR);
    expect(await makeGenerator(oneShot).sweep()).toBe(true);
    const state = await store.readMeesterStatusState();
    expect(state.runsOnDay).toBe(1);
  });

  it('skips when no project changed since the last run', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => modelOutput());
    const gen = makeGenerator(oneShot);
    expect(await gen.sweep()).toBe(true);

    nowMs += 3 * HOUR;
    expect(await gen.sweep()).toBe(false);
    expect(oneShot).toHaveBeenCalledTimes(1);
  });

  it('manual runNow bypasses idle/budget/change gates but honors engagement off', async () => {
    await seedActiveProject();
    const oneShot = vi.fn(async () => modelOutput());
    const day = localDay(new Date(nowMs));
    await store.writeMeesterStatusState({ runDay: day, runsOnDay: 99 });

    const gen = makeGenerator(oneShot, { isChatActive: () => true });
    expect(await gen.runNow()).toBe(true);
    const report = await store.readMeesterStatus();
    expect(report?.trigger).toBe('manual');
    // Manual runs don't consume the automatic budget.
    expect((await store.readMeesterStatusState()).runsOnDay).toBe(99);

    await store.writeConfig({ aiEngagementMode: 'off' });
    expect(await makeGenerator(oneShot).runNow()).toBe(false);
  });

  it('keeps the prior report but consumes budget when the model output is unparseable', async () => {
    await seedActiveProject();
    const good = vi.fn(async () => modelOutput());
    const events = { publishGlobalEvent: vi.fn() };
    expect(await makeGenerator(good, { events }).sweep()).toBe(true);

    nowMs += 3 * HOUR;
    const projectId = (await store.listProjects())[0]?.id ?? '';
    activity.stamp(projectId, nowMs - 60_000);
    const bad = vi.fn(async () => 'I could not decide what to write.');
    expect(await makeGenerator(bad, { events }).sweep()).toBe(false);

    const report = await store.readMeesterStatus();
    expect(report?.headline).toBe('Your birdhouse is nearly done! Click to see it!');
    const state = await store.readMeesterStatusState();
    expect(state.runsOnDay).toBe(2);
    expect(events.publishGlobalEvent).toHaveBeenCalledWith({
      type: 'meester_status',
      state: 'failed',
    });
  });

  it('drops a CTA that points at a project or task that does not exist', async () => {
    const projectId = await seedActiveProject();
    const dead = vi.fn(async () =>
      modelOutput({
        cta: { label: 'Open it', target: { kind: 'project', projectId: 'gone' } },
      }),
    );
    expect(await makeGenerator(dead).runNow()).toBe(true);
    expect((await store.readMeesterStatus())?.cta).toBeUndefined();

    const live = vi.fn(async () =>
      modelOutput({ cta: { label: 'Open it', target: { kind: 'project', projectId } } }),
    );
    expect(await makeGenerator(live).runNow()).toBe(true);
    expect((await store.readMeesterStatus())?.cta?.target).toMatchObject({ projectId });
  });

  it('materializes follow-up actions as draft tasks for the voorman, deduped across runs', async () => {
    const projectId = await seedActiveProject();
    const voorman = await store.createGezel({ name: 'Pip', role: 'Bouwer' });
    await store.updateProject(projectId, { voormanGezelId: voorman.id });

    const withAction = () =>
      vi.fn(async () =>
        modelOutput({
          actions: [
            {
              projectId,
              title: 'Review the stalled roof task',
              description: 'The roof task has not moved in two days — check what is blocking it.',
            },
          ],
        }),
      );
    expect(await makeGenerator(withAction()).runNow()).toBe(true);

    const report = await store.readMeesterStatus();
    expect(report?.actions).toHaveLength(1);
    const created = await store.listProjectTasks(projectId);
    const draft = created.find((t) => t.title === 'Review the stalled roof task');
    expect(draft?.status).toBe('draft');
    expect(draft?.assignee).toEqual({ kind: 'gezel', gezelId: voorman.id });
    expect(draft?.createdBy).toEqual({ kind: 'gezel', gezelId: meesterId });

    // Same proposal again → no duplicate task, action not re-recorded.
    expect(await makeGenerator(withAction()).runNow()).toBe(true);
    const after = await store.listProjectTasks(projectId);
    expect(after.filter((t) => t.title === 'Review the stalled roof task')).toHaveLength(1);
    expect((await store.readMeesterStatus())?.actions).toHaveLength(0);
  });
});
