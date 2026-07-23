import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatEventBus } from '../chat/events.js';
import { ActivityTracker } from '../fs/activity-tracker.js';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskManager } from './manager.js';
import { TaskScheduler } from './scheduler.js';

let home: string;
let store: Store;
let history: HistoryManager;
let tasks: TaskManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-sched-'));
  history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.createProject({ name: 'Cron' });
  tasks = new TaskManager(store, history);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('TaskScheduler', () => {
  it('records a task.tick when a task cron is overdue', async () => {
    const created = await tasks.create('cron', {
      title: 'Nightly check',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
      cron: { expression: '0 9 * * *' },
    });
    // Force the next tick into the past so it's overdue.
    const overdue = await store.readTask('cron', created.num);
    await store.writeTask({
      ...overdue!,
      cron: { expression: '0 9 * * *', nextTickAt: '2020-01-01T09:00:00Z' },
    });

    const scheduler = new TaskScheduler({ manager: tasks, intervalMs: 10_000 });
    await scheduler.tick();

    const ticks = await history.listEvents({ kinds: ['task.tick'] });
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.summary).toMatch(/Nightly check/);

    // lastTickAt advanced; nextTickAt is in the future.
    const updated = await store.readTask('cron', created.num);
    expect(updated?.cron?.lastTickAt).toBeTruthy();
    expect(Date.parse(updated!.cron!.nextTickAt!)).toBeGreaterThan(Date.now());
  });

  it('skips non-active tasks', async () => {
    const t = await tasks.create('cron', {
      title: 'Paused one',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
      cron: { expression: '* * * * *' },
    });
    await tasks.setStatus('cron', t.num, 'paused');
    // Force overdue.
    const record = await store.readTask('cron', t.num);
    await store.writeTask({
      ...record!,
      cron: { expression: '* * * * *', nextTickAt: '2020-01-01T00:00:00Z' },
    });
    const scheduler = new TaskScheduler({ manager: tasks });
    await scheduler.tick();
    const ticks = await history.listEvents({ kinds: ['task.tick'] });
    expect(ticks).toHaveLength(0);
  });

  it('spawns a child when a cron-with-template is overdue', async () => {
    const parent = await tasks.create('cron', {
      title: 'Daily brief',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Collect', suggestedGezelId: 'maya' }],
      cron: { expression: '0 9 * * *' },
    });
    const stored = await store.readTask('cron', parent.num);
    await store.writeTask({
      ...stored!,
      cron: { expression: '0 9 * * *', nextTickAt: '2020-01-01T09:00:00Z' },
    });

    const scheduler = new TaskScheduler({ manager: tasks });
    await scheduler.tick();

    const children = await tasks.listChildren(parent.ref);
    expect(children).toHaveLength(1);
    expect(children[0]?.parentTaskRef).toBe(parent.ref);
    expect(children[0]?.craftbook.steps[0]?.name).toBe('Collect');

    const spawns = await history.listEvents({ kinds: ['task.instance.spawned'] });
    expect(spawns).toHaveLength(1);
  });

  it("overlap='skip' blocks new child when prior is still active", async () => {
    const parent = await tasks.create('cron', {
      title: 'Slow job',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Work' }],
      cron: { expression: '* * * * *', overlap: 'skip' },
    });
    // Pre-seed an active child.
    await tasks.spawnChild(parent.ref);
    const before = await tasks.listChildren(parent.ref);
    expect(before).toHaveLength(1);

    // Force overdue.
    const stored = await store.readTask('cron', parent.num);
    await store.writeTask({
      ...stored!,
      cron: { expression: '* * * * *', nextTickAt: '2020-01-01T00:00:00Z', overlap: 'skip' },
    });

    const scheduler = new TaskScheduler({ manager: tasks });
    await scheduler.tick();

    const after = await tasks.listChildren(parent.ref);
    expect(after).toHaveLength(1);
  });

  it("overlap='queue' spawns even if a prior child is still active", async () => {
    const parent = await tasks.create('cron', {
      title: 'Fast job',
      assignee: { kind: 'user' },
      steps: [{ name: 'Wait' }],
      spawnsSteps: [{ name: 'Check' }],
      cron: { expression: '* * * * *', overlap: 'queue' },
    });
    await tasks.spawnChild(parent.ref);

    const stored = await store.readTask('cron', parent.num);
    await store.writeTask({
      ...stored!,
      cron: { expression: '* * * * *', nextTickAt: '2020-01-01T00:00:00Z', overlap: 'queue' },
    });

    const scheduler = new TaskScheduler({ manager: tasks });
    await scheduler.tick();

    const children = await tasks.listChildren(parent.ref);
    expect(children).toHaveLength(2);
  });

  it('cron without template stays metadata-only (back-compat)', async () => {
    const parent = await tasks.create('cron', {
      title: 'Old cron task',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
      cron: { expression: '0 9 * * *' },
    });
    const stored = await store.readTask('cron', parent.num);
    await store.writeTask({
      ...stored!,
      cron: { expression: '0 9 * * *', nextTickAt: '2020-01-01T09:00:00Z' },
    });

    const scheduler = new TaskScheduler({ manager: tasks });
    await scheduler.tick();

    expect(await tasks.listChildren(parent.ref)).toHaveLength(0);
    const ticks = await history.listEvents({ kinds: ['task.tick'] });
    expect(ticks).toHaveLength(1);
  });
});

describe('TaskScheduler — ambient project nudges', () => {
  // Minimal stand-in for ChatManager. The scheduler only calls
  // `isProjectActive` + `isGezelActive` (is anyone mid-turn?) and
  // `messageGezel` (deliver the nudge). We assert on the
  // delivered-messages array.
  function fakeChat() {
    const delivered: Array<{
      toGezelIdOrName: string;
      projectId: string;
      text: string;
      lane: 'interactive' | 'background' | undefined;
    }> = [];
    let projectActive = false;
    let gezelActive = false;
    let activeGezelIds: Set<string> | null = null;
    let queueSnap: {
      running: number;
      queuedInteractive: number;
      queuedBackground: number;
    } | null = null;
    return {
      delivered,
      setProjectActive(next: boolean) {
        projectActive = next;
      },
      setGezelActive(next: boolean) {
        gezelActive = next;
      },
      // Per-gezel active state — lets a test mark a specific delegate
      // (not the voorman) as mid-turn. Overrides the boolean when set.
      setActiveGezels(ids: string[]) {
        activeGezelIds = new Set(ids);
      },
      setQueueSnapshot(
        next: { running: number; queuedInteractive: number; queuedBackground: number } | null,
      ) {
        queueSnap = next;
      },
      isProjectActive: (_projectId: string) => projectActive,
      isGezelActive: (gezelId: string) =>
        activeGezelIds ? activeGezelIds.has(gezelId) : gezelActive,
      providerForGezel: async (_gezelId: string) => 'ollama' as const,
      getProviderIfReady: (_name: string) =>
        queueSnap === null ? null : { queue: { snapshot: () => queueSnap } },
      messageGezel: async (args: {
        fromGezelId: string;
        toGezelIdOrName: string;
        projectId: string;
        text: string;
        lane?: 'interactive' | 'background';
      }) => {
        delivered.push({
          toGezelIdOrName: args.toGezelIdOrName,
          projectId: args.projectId,
          text: args.text,
          lane: args.lane,
        });
        return {
          sessionId: 'mock-session',
          toGezelName: args.toGezelIdOrName,
          toGezelId: args.toGezelIdOrName,
        };
      },
    };
  }

  async function setupProject(
    opts: {
      voormanGezelId?: string | undefined;
      meesterGezelId?: string;
      createdAt?: string;
      updatedAt?: string;
      lastNudgedAt?: string;
      consecutiveRapidNudges?: number;
      nudgeConfig?: {
        enabled?: boolean;
        firstNudgeGraceMs?: number;
        rapidIntervalMs?: number;
        slowIntervalMs?: number;
        recentActivityWindowMs?: number;
        rapidAttemptsBeforeBackoff?: number;
      };
      workingDir?: string;
      allowGezelWrites?: boolean;
    } = {},
  ): Promise<void> {
    // Overwrite project.json directly so we can set updatedAt to a
    // precise moment in the past.
    const record = await store.getProject('cron');
    if (!record) throw new Error('setup requires the beforeEach-created "cron" project');
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');
    const path = pjoin(home, 'projects', 'cron', 'project.json');
    const raw = JSON.parse(await readFile(path, 'utf8'));
    raw.voormanGezelId = opts.voormanGezelId;
    raw.updatedAt = opts.updatedAt ?? raw.updatedAt;
    // Default createdAt to a long-ago moment so the new first-nudge
    // grace period doesn't suppress nudges in tests that don't care
    // about the project's age. Tests that DO care override it.
    raw.createdAt = opts.createdAt ?? '2020-01-01T00:00:00Z';
    if (opts.workingDir !== undefined) raw.workingDir = opts.workingDir;
    if (opts.allowGezelWrites !== undefined) raw.allowGezelWrites = opts.allowGezelWrites;
    if (opts.lastNudgedAt || opts.consecutiveRapidNudges !== undefined) {
      raw.nudgeState = {
        ...(opts.lastNudgedAt ? { lastNudgedAt: opts.lastNudgedAt } : {}),
        ...(opts.consecutiveRapidNudges !== undefined
          ? { consecutiveRapidNudges: opts.consecutiveRapidNudges }
          : {}),
      };
    }
    if (opts.nudgeConfig) {
      raw.nudgeConfig = opts.nudgeConfig;
    }
    await writeFile(path, JSON.stringify(raw, null, 2), 'utf8');
    if (opts.meesterGezelId) {
      await store.writeConfig({ meesterGezelId: opts.meesterGezelId });
    }
  }

  // Write a voorman session directly into the store so the scheduler's
  // `lastTurnError` check has something to read. `writeSession` mkdir's the
  // gezel's session dir, so no gezel record is needed (matching how the
  // other tests use bare voorman ids).
  async function writeVoormanSession(opts: {
    id: string;
    gezelId: string;
    lastActivityAt: string;
    lastTurnError?: string;
    archived?: boolean;
  }): Promise<void> {
    await store.writeSession({
      version: 1,
      id: opts.id,
      gezelId: opts.gezelId,
      projectId: 'cron',
      providerName: 'copilot',
      title: 'Voorman session',
      createdAt: '2020-01-01T00:00:00Z',
      lastActivityAt: opts.lastActivityAt,
      messages: [],
      providerState: {},
      ...(opts.lastTurnError ? { lastTurnError: opts.lastTurnError } : {}),
      ...(opts.archived ? { archived: true } : {}),
    });
  }

  it('skips projects without a voorman', async () => {
    await setupProject({ meesterGezelId: 'meester-1' });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
  });

  it('skips projects where a session is mid-turn', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    });
    const chat = fakeChat();
    chat.setProjectActive(true); // someone's mid-turn in this project
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
  });

  it('skips when the voorman is mid-turn anywhere (not just this project)', async () => {
    // A voorman who is the foreman of multiple projects can only think
    // about one thing at a time. When they're mid-turn on project B,
    // we must not nudge them about project A — the nudge would hit the
    // "already in flight" guard and get silently dropped.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    });
    const chat = fakeChat();
    chat.setProjectActive(false); // no session in THIS project is busy
    chat.setGezelActive(true); // but the voorman is busy elsewhere
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
  });

  it('fires a rapid nudge when project is recently active and voorman is idle', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(), // 10 min ago
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(1);
    expect(chat.delivered[0]!.toGezelIdOrName).toBe('leo');
    expect(chat.delivered[0]!.text).toContain('Checking in on');
    // Ambient nudges must ride the background lane so a user-driven
    // turn sharing the same provider always preempts them.
    expect(chat.delivered[0]!.lane).toBe('background');
    const record = await store.getProject('cron');
    expect(record!.nudgeState?.consecutiveRapidNudges).toBe(1);
  });

  it('treats tracker-stamped activity as recent even when project.updatedAt is stale', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      // Metadata edit 7h ago + a nudge 30 min ago: slow cadence (6h)
      // would skip. Only the tracker's fresher stamp can flip the
      // project into rapid mode and let the nudge through.
      updatedAt: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(),
      lastNudgedAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
    });
    const chat = fakeChat();
    const activity = new ActivityTracker({ store, history, chatEvents: new ChatEventBus() });
    activity.stamp('cron', now.getTime() - 10 * 60_000);
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
      activity,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(1);

    // Without the tracker the same setup stays in slow mode and skips.
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(),
      lastNudgedAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
    });
    const quiet = fakeChat();
    const bare = new TaskScheduler({
      manager: tasks,
      chat: quiet as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await bare.tick();
    expect(quiet.delivered).toHaveLength(0);
  });

  it('keeps Meester check-ins for internal projects under super-lockdown (per-project gate)', async () => {
    // Workspace writability is per-project now: super-lockdown no longer
    // pauses nudges on internal-workspace projects (they stay writable).
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    await store.writeConfig({ securityPolicy: securityPolicyForLevel('super-lockdown') });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });

    await scheduler.tick();

    expect(chat.delivered).toHaveLength(1);
  });

  it('skips Meester check-ins when the project explicitly disables gezel writes', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
      allowGezelWrites: false,
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });

    await scheduler.tick();

    expect(chat.delivered).toHaveLength(0);
  });

  it('skips Meester check-ins when edits are off for an external project workspace', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
      workingDir: join(home, 'external-workspace'),
      allowGezelWrites: false,
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });

    await scheduler.tick();

    expect(chat.delivered).toHaveLength(0);
  });

  it('keeps Meester check-ins enabled for an explicitly writable external workspace', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
      workingDir: join(home, 'external-workspace'),
      allowGezelWrites: true,
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });

    await scheduler.tick();

    expect(chat.delivered).toHaveLength(1);
  });

  it('skips the nudge while a delegate is mid-turn on an active task', async () => {
    // Same eligible setup as the rapid-nudge test above, but the
    // voorman has delegated an active task to a builder who is currently
    // writing the deliverable. Pinging "anything stuck?" here just
    // spawns a redundant re-planning turn (wild-caught).
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    await tasks.create('cron', {
      title: 'Build the deliverable',
      assignee: { kind: 'gezel', gezelId: 'freja' },
      steps: [{ name: 'Main' }],
    });
    const chat = fakeChat();
    chat.setActiveGezels(['freja']); // delegate mid-turn, voorman idle
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
  });

  it('still nudges when the delegated task assignee is idle (not mid-turn)', async () => {
    // The guard is specifically "delegate is actively working" — an
    // assigned-but-idle task must NOT suppress the check-in, else a
    // stalled delegation would never get surfaced.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    await tasks.create('cron', {
      title: 'Build the deliverable',
      assignee: { kind: 'gezel', gezelId: 'freja' },
      steps: [{ name: 'Main' }],
    });
    const chat = fakeChat();
    chat.setActiveGezels([]); // nobody mid-turn
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(1);
  });

  it("skips the nudge when the voorman's most-recent session aborted last turn recently", async () => {
    // The wild-caught failure: the meester's "anything stuck?" check-in
    // landed on a session that had just aborted (write_artifact failure
    // loop), and the re-prompt produced a pure repetition loop instead of
    // recovery. A freshly-poisoned session must not be re-poked — a user
    // turn or the revival cooldown (below) clears it.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    await writeVoormanSession({
      id: 'leo-cron-1',
      gezelId: 'leo',
      lastActivityAt: new Date(now.getTime() - 3 * 60_000).toISOString(),
      lastTurnError: '[Mac AI] aborting — `write_artifact` failed 5 times in a row this turn.',
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
  });

  it('attempts a revival nudge once a poisoned voorman session has idled past the cooldown', async () => {
    // Unattended (autostart daemon, evals) no user turn ever arrives, so a
    // permanent skip made one aborted voorman turn fatal to the project
    // (wild-caught core sweep: gemma4-26b-q4 / data-wrangle).
    // After 8 min idle the scheduler tries one revival turn; success clears
    // lastTurnError, another abort re-poisons for another cooldown.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
    });
    await writeVoormanSession({
      id: 'leo-cron-1',
      gezelId: 'leo',
      lastActivityAt: new Date(now.getTime() - 9 * 60_000).toISOString(),
      lastTurnError: '[Mac AI] aborting — `write_artifact` failed 5 times in a row this turn.',
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(1);
  });

  it('still nudges when a newer healthy session supersedes an older aborted one', async () => {
    // The check is "the session the nudge would LAND on" — i.e. the most-
    // recent non-archived session. An older aborted session must not
    // suppress nudges once the voorman has moved on to a healthy one.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    await writeVoormanSession({
      id: 'leo-cron-old',
      gezelId: 'leo',
      lastActivityAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
      lastTurnError: 'old abort',
    });
    await writeVoormanSession({
      id: 'leo-cron-new',
      gezelId: 'leo',
      lastActivityAt: new Date(now.getTime() - 8 * 60_000).toISOString(),
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(1);
  });

  it('ignores an archived aborted session (a nudge would open a fresh one)', async () => {
    // ensureOrCreateSession skips archived sessions, so an archived abort is
    // not the session a nudge lands on — it must not suppress the check-in.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    await writeVoormanSession({
      id: 'leo-cron-archived',
      gezelId: 'leo',
      lastActivityAt: new Date(now.getTime() - 9 * 60_000).toISOString(),
      lastTurnError: 'archived abort',
      archived: true,
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(1);
  });

  it('skips the very first nudge while the project is inside the first-nudge grace period', async () => {
    // A freshly-kicked-off project (created 5 min ago) under the
    // default `bedrijvig` tempo, which has a 10-min first-nudge
    // grace, should be left alone — even though the rapid 5-min
    // interval would otherwise have fired.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      createdAt: new Date(now.getTime() - 5 * 60_000).toISOString(), // 5 min old
      updatedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
    // No nudge state recorded — we deferred, didn't deliver.
    const record = await store.getProject('cron');
    expect(record!.nudgeState?.lastNudgedAt).toBeUndefined();
  });

  it('grace period only applies to the very first nudge — subsequent nudges follow normal cadence', async () => {
    // Same young (10-min-old) project, but it has already received a
    // nudge in the past. The grace guard is a one-shot — once
    // `lastNudgedAt` is set, normal rapid/slow cadence takes over.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      createdAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
      updatedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      lastNudgedAt: new Date(now.getTime() - 6 * 60_000).toISOString(), // 6 min ago, > 5 min rapid interval
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(1);
  });

  it('per-project firstNudgeGraceMs override of 0 restores legacy first-nudge behavior', async () => {
    // A project that opts out of the grace via firstNudgeGraceMs: 0
    // sees the old behavior — first nudge fires as soon as the
    // rapid interval allows.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      createdAt: new Date(now.getTime() - 6 * 60_000).toISOString(), // young
      updatedAt: new Date(now.getTime() - 6 * 60_000).toISOString(),
      nudgeConfig: { firstNudgeGraceMs: 0 },
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(1);
  });

  it('skips the nudge when the project has a pending ask_user_question', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    // Voorman has already posted a structured question — the user is on
    // the hook, not the voorman, so the health check is noise.
    await store.writeQuestion({
      id: 'q-open',
      projectId: 'cron',
      gezelId: 'leo',
      sessionId: 'sess-x',
      prompt: 'Do you want the logo to feature an animal?',
      createdAt: now.toISOString(),
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
  });

  it('still fires the nudge when every question on the project is answered', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    await store.writeQuestion({
      id: 'q-closed',
      projectId: 'cron',
      gezelId: 'leo',
      sessionId: 'sess-x',
      prompt: 'Prior question',
      createdAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      answer: { writeIn: 'sure', at: new Date(now.getTime() - 30 * 60_000).toISOString() },
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(1);
  });

  it('backs off to slow cadence after three unanswered rapid nudges', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 90 * 60_000).toISOString(), // 90 min ago — no recent activity
      lastNudgedAt: new Date(now.getTime() - 10 * 60_000).toISOString(), // 10 min ago
      consecutiveRapidNudges: 3, // at the backoff threshold
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    // 10 min since last nudge is far below the 6h slow interval → no fire.
    expect(chat.delivered).toHaveLength(0);
  });

  it('resets the rapid counter when real activity happens after a nudge', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    // Nudge fired at T-10m, then a project metadata edit at T-2m —
    // `project.updatedAt` only moves on explicit config changes, which
    // counts as organic activity.
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
      lastNudgedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
      consecutiveRapidNudges: 3,
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    // Counter reset, 10 min > 5 min rapid interval, recent activity → fire.
    expect(chat.delivered).toHaveLength(1);
    const record = await store.getProject('cron');
    // Reset to 0 then incremented on this fire = 1.
    expect(record!.nudgeState?.consecutiveRapidNudges).toBe(1);
  });

  it('skips the nudge when the voormans provider has 2+ INTERACTIVE items queued', async () => {
    // User work in flight (mention fan-outs, task handoffs, real chats)
    // should pre-empt the ambient nudge — let it drain first.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    });
    const chat = fakeChat();
    chat.setQueueSnapshot({ running: 1, queuedInteractive: 2, queuedBackground: 0 });
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
  });

  it('STILL fires the nudge when only background items are queued (icon/about generation)', async () => {
    // Regression: a fresh `start_project` triggers icon + about
    // background jobs for every recruited gezel — easily 4-6 queued
    // background items on a single-slot local model. The old check
    // counted those toward the `>= 2` threshold, which permanently
    // suppressed the first ambient nudge until the bootstrap drained.
    // Background work doesn't compete with user-facing turns; the
    // nudge (also `lane: 'background'`) just queues behind it.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    });
    const chat = fakeChat();
    chat.setQueueSnapshot({ running: 1, queuedInteractive: 0, queuedBackground: 6 });
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(1);
    expect(chat.delivered[0]?.toGezelIdOrName).toBe('leo');
  });

  it('skips nudging when config.enabled is false', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    });
    // Turn off nudges via project override.
    await store.updateProject('cron', { nudgeConfig: { enabled: false } });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
  });

  it('a human message after the nudge resets the rapid counter (cadence from chat traffic)', async () => {
    // Regression: `project.updatedAt` is never bumped by chat activity —
    // only by metadata edits. A project the USER is actively discussing
    // via sessions would silently drop into slow mode after an hour
    // without this. Only human messages count toward the reset — see the
    // nudge-reply test below for the inverse.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      // Project metadata was last edited 3 hours ago — far outside
      // the 1 hour recent-activity window.
      updatedAt: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
      // Nudged 45 min ago, already 3 rapid attempts consumed → would
      // be in slow mode if we only looked at project.updatedAt.
      lastNudgedAt: new Date(now.getTime() - 45 * 60_000).toISOString(),
      consecutiveRapidNudges: 3,
    });
    // But the user messaged the voorman 2 minutes ago (a human message:
    // `role: 'user'` with no `from`).
    await store.writeSession({
      version: 1,
      id: 'sess-recent',
      gezelId: 'leo',
      projectId: 'cron',
      providerName: 'openai',
      model: 'gpt-4o-mini',
      title: 'chatting',
      messages: [
        {
          role: 'user',
          content: 'can you add a score multiplier for streaks?',
          at: new Date(now.getTime() - 2 * 60_000).toISOString(),
        },
      ],
      providerState: {},
      createdAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
      lastActivityAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
    });

    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    // Human message (2 min ago) > lastNudgedAt → reset the rapid
    // counter. Then 45 min > 5 min rapid interval → fire.
    expect(chat.delivered).toHaveLength(1);
    const record = await store.getProject('cron');
    expect(record!.nudgeState?.consecutiveRapidNudges).toBe(1);
  });

  it('the voorman answering the nudge does NOT reset the rapid counter (backoff engages)', async () => {
    // The wild-caught loop (qwen3.6 "Space Shooter Arcade"):
    // every check-in got a polite "all done!" reply, the reply bumped
    // `lastActivityAt`, the old raw-activity reset cleared the counter,
    // and the project stayed on the 5-minute rapid cadence forever. A
    // nudge reply with no human message and no task movement must count
    // toward backoff, not against it.
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
      lastNudgedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
      consecutiveRapidNudges: 3,
    });
    // The voorman's session is fresh — but only because they answered
    // the meester's check-in: a meester-injected message (carries
    // `from`) plus the voorman's reply. No human anywhere.
    await store.writeSession({
      version: 1,
      id: 'sess-nudge-loop',
      gezelId: 'leo',
      projectId: 'cron',
      providerName: 'openai',
      title: 'nudge loop',
      messages: [
        {
          role: 'user',
          content: '[Message from Zephyr]: Checking in on Cron. Anything stuck?',
          at: new Date(now.getTime() - 10 * 60_000).toISOString(),
          from: { gezelId: 'meester-1', gezelName: 'Zephyr' },
        },
        {
          role: 'assistant',
          content: 'All objectives met — nothing stuck, nothing to advance.',
          at: new Date(now.getTime() - 8 * 60_000).toISOString(),
        },
      ],
      providerState: {},
      createdAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      lastActivityAt: new Date(now.getTime() - 8 * 60_000).toISOString(),
    });

    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    // Counter stays at 3 → slow mode → 10 min < 6 h → no nudge.
    expect(chat.delivered).toHaveLength(0);
    const record = await store.getProject('cron');
    expect(record!.nudgeState?.consecutiveRapidNudges).toBe(3);
  });

  it('brings a stuck-active project to rest instead of nudging when no tasks are active', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    // Close the only task (which auto-stabilizes), then force the status
    // back to `active` to simulate the stuck state — a stabilization
    // that raced, or a project that predates the stable lifecycle.
    const t = await tasks.create('cron', {
      title: 'Ship it',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
    });
    await tasks.setStatus('cron', t.num, 'complete');
    await store.updateProject('cron', { status: 'active' });

    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();

    // No nudge fired, and the project was healed to `stable` so every
    // other ambient surface (cron ticks, step handoffs) quiets too.
    expect(chat.delivered).toHaveLength(0);
    expect((await store.getProject('cron'))?.status).toBe('stable');
  });

  it('skips when no meester is set', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    // voorman set, but no meester to send from.
    await setupProject({
      voormanGezelId: 'leo',
      updatedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
  });

  it('dolle-boel tempo fires a nudge at 90s since last, where bedrijvig would skip', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
      lastNudgedAt: new Date(now.getTime() - 90_000).toISOString(), // 90s ago
      consecutiveRapidNudges: 1,
    });
    // Under bedrijvig (default, 5-min rapid cadence) a 90s-old last
    // nudge is too recent — confirm we'd skip.
    const chatDefault = fakeChat();
    const schedulerDefault = new TaskScheduler({
      manager: tasks,
      chat: chatDefault as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await schedulerDefault.tick();
    expect(chatDefault.delivered).toHaveLength(0);

    // Flip to dolle-boel (45s rapid cadence) and the same state fires.
    await store.writeConfig({ workshopTempo: 'dolle-boel' });
    const chatDolle = fakeChat();
    const schedulerDolle = new TaskScheduler({
      manager: tasks,
      chat: chatDolle as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await schedulerDolle.tick();
    expect(chatDolle.delivered).toHaveLength(1);
    // Dolle-boel tone: the nudge shouts the project name and ends with
    // the "this is fine 🔥" gag.
    expect(chatDolle.delivered[0]!.text).toMatch(/CRON/); // projectName upper-cased
    expect(chatDolle.delivered[0]!.text).toMatch(/this is fine/i);
  });

  it('skips nudges when engagement mode is scheduled (non-proactive)', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setupProject({
      voormanGezelId: 'leo',
      meesterGezelId: 'meester-1',
      updatedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    });
    await store.writeConfig({ aiEngagementMode: 'scheduled' });
    const chat = fakeChat();
    const scheduler = new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
    await scheduler.tick();
    expect(chat.delivered).toHaveLength(0);
  });
});

describe('TaskScheduler — idle step supervisor (sweepStuckSteps)', () => {
  // Minimal ChatManager stand-in: the supervisor only reads `isProjectActive`
  // / `isGezelActive` and delivers re-drives via `messageGezel`.
  function fakeChat() {
    const delivered: Array<{
      toGezelIdOrName: string;
      projectId: string;
      text: string;
      lane: string | undefined;
    }> = [];
    let activeGezels = new Set<string>();
    let projectActive = false;
    return {
      delivered,
      setActiveGezels(ids: string[]) {
        activeGezels = new Set(ids);
      },
      setProjectActive(v: boolean) {
        projectActive = v;
      },
      isProjectActive: (_projectId: string) => projectActive,
      isGezelActive: (gezelId: string) => activeGezels.has(gezelId),
      providerForGezel: async (_gezelId: string) => 'ollama' as const,
      getProviderIfReady: (_name: string) => null,
      messageGezel: async (args: {
        fromGezelId: string;
        toGezelIdOrName: string;
        projectId: string;
        text: string;
        lane?: string;
      }) => {
        delivered.push({
          toGezelIdOrName: args.toGezelIdOrName,
          projectId: args.projectId,
          text: args.text,
          lane: args.lane,
        });
        return {
          sessionId: 'mock',
          toGezelName: args.toGezelIdOrName,
          toGezelId: args.toGezelIdOrName,
        };
      },
    };
  }

  async function setProjectVoorman(voorman: string, meester = 'zephyr'): Promise<void> {
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join: pjoin } = await import('node:path');
    const path = pjoin(home, 'projects', 'cron', 'project.json');
    const raw = JSON.parse(await readFile(path, 'utf8'));
    raw.voormanGezelId = voorman;
    raw.createdAt = '2020-01-01T00:00:00Z';
    await writeFile(path, JSON.stringify(raw, null, 2), 'utf8');
    await store.writeConfig({ meesterGezelId: meester });
  }

  // An active task whose gezel-owned entry step carries an advanceWhen+gate
  // deliverable and was last touched `agoMs` before `now`.
  async function makeStalledTask(opts: {
    now: Date;
    agoMs: number;
    redriveCount?: number;
    gezel?: string;
  }): Promise<{ num: number; entryStepId: string; nextStepId: string }> {
    const gezel = opts.gezel ?? 'freja';
    const created = await tasks.create('cron', {
      title: 'Threat model',
      assignee: { kind: 'gezel', gezelId: gezel },
      steps: [{ name: 'Scope' }, { name: 'Done' }],
    });
    const rec = await store.readTask('cron', created.num);
    const entryStepId = rec!.craftbook.steps[0]!.id;
    const nextStepId = rec!.craftbook.steps[1]!.id;
    const steps = rec!.craftbook.steps.map((s, i) =>
      i === 0
        ? {
            ...s,
            advanceWhen: { file: 'notes/scope.md', minBytes: 1, sniff: 'nonempty' as const },
            gate: {
              at: 'completion' as const,
              checks: [{ kind: 'minBytes' as const, file: 'notes/scope.md', bytes: 120 }],
              onReject: entryStepId,
              maxAttempts: 3,
            },
            lastActivatedAt: new Date(opts.now.getTime() - opts.agoMs).toISOString(),
            ...(opts.redriveCount !== undefined ? { redriveCount: opts.redriveCount } : {}),
          }
        : s,
    );
    await store.writeTask({
      ...rec!,
      craftbook: { ...rec!.craftbook, steps },
      activeStepId: entryStepId,
    });
    return { num: created.num, entryStepId, nextStepId };
  }

  function makeScheduler(chat: ReturnType<typeof fakeChat>, now: Date): TaskScheduler {
    return new TaskScheduler({
      manager: tasks,
      chat: chat as unknown as ConstructorParameters<typeof TaskScheduler>[0]['chat'],
      store,
      now: () => now,
    });
  }

  it('re-drives a silently stalled assignee in their own session', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setProjectVoorman('leo');
    const { num, entryStepId } = await makeStalledTask({ now, agoMs: 30 * 60_000 });
    const chat = fakeChat();
    await makeScheduler(chat, now).sweepStuckSteps();
    expect(chat.delivered).toHaveLength(1);
    expect(chat.delivered[0]!.toGezelIdOrName).toBe('freja');
    expect(chat.delivered[0]!.text).toContain(entryStepId);
    expect(chat.delivered[0]!.text).toMatch(/advance_task_step/);
    // Ambient re-drive rides the background lane.
    expect(chat.delivered[0]!.lane).toBe('background');
    // Re-drive bookkeeping bumped.
    const rec = await store.readTask('cron', num);
    expect(rec!.craftbook.steps[0]!.redriveCount).toBe(1);
  });

  it('skips the re-drive when the project has an unanswered user question', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setProjectVoorman('leo');
    const { num } = await makeStalledTask({ now, agoMs: 30 * 60_000 });
    // The step reads as "stalled" only because its gezel asked the user
    // something and is waiting for the answer — re-poking it just re-loops.
    await store.writeQuestion({
      id: 'q-stalled',
      projectId: 'cron',
      gezelId: 'freja',
      sessionId: 'sess-freja',
      prompt: 'Which layout do you want?',
      createdAt: now.toISOString(),
    });
    const chat = fakeChat();
    await makeScheduler(chat, now).sweepStuckSteps();
    // No re-drive delivered, and the re-drive counter was NOT bumped.
    expect(chat.delivered).toHaveLength(0);
    const rec = await store.readTask('cron', num);
    expect(rec!.craftbook.steps[0]!.redriveCount ?? 0).toBe(0);
  });

  it('auto-advances (no model turn) when the deliverable already clears the gate', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setProjectVoorman('leo');
    const { num, nextStepId } = await makeStalledTask({ now, agoMs: 30 * 60_000 });
    // Deliverable already present and over the 120-byte gate floor.
    await store.writeProjectWorkspaceFile('cron', 'notes/scope.md', 'x'.repeat(200));
    const chat = fakeChat();
    await makeScheduler(chat, now).sweepStuckSteps();
    // Advanced, not re-driven.
    expect(chat.delivered).toHaveLength(0);
    const rec = await store.readTask('cron', num);
    expect(rec!.activeStepId).toBe(nextStepId);
  });

  it('fresh gate reject → no redrive; frozen deliverable on the next sweep → gate-aware redrive', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setProjectVoorman('leo');
    const { num, entryStepId } = await makeStalledTask({ now, agoMs: 30 * 60_000 });
    // Strip the onReject loop-back so the step holds in place: the damper
    // (lastGateReject) persists between sweeps — the frozen-deliverable
    // shape the redrive fall-through exists for.
    const rec0 = await store.readTask('cron', num);
    await store.writeTask({
      ...rec0!,
      craftbook: {
        ...rec0!.craftbook,
        steps: rec0!.craftbook.steps.map((s) =>
          s.id === entryStepId
            ? {
                ...s,
                gate: {
                  at: 'completion' as const,
                  checks: [{ kind: 'minBytes' as const, file: 'notes/scope.md', bytes: 120 }],
                  maxAttempts: 5,
                },
              }
            : s,
        ),
      },
    });
    // Satisfies advanceWhen (nonempty) but fails the 120-byte gate floor.
    await store.writeProjectWorkspaceFile('cron', 'notes/scope.md', 'x'.repeat(30));

    const chat = fakeChat();
    // Sweep 1: gate runs, FRESH rejection — the verdict just landed, so no
    // redrive this tick.
    await makeScheduler(chat, now).sweepStuckSteps();
    expect(chat.delivered).toHaveLength(0);
    const afterFirst = await store.readTask('cron', num);
    expect(
      afterFirst!.craftbook.steps.find((s) => s.id === entryStepId)!.lastGateReject,
    ).toBeTruthy();

    // Sweep 2: deliverable unchanged → damper replay (held-frozen) → fall
    // through to the redrive with the gate's verdict in the text.
    await makeScheduler(chat, now).sweepStuckSteps();
    expect(chat.delivered).toHaveLength(1);
    expect(chat.delivered[0]!.toGezelIdOrName).toBe('freja');
    expect(chat.delivered[0]!.text).toContain('completion gate keeps rejecting');
    expect(chat.delivered[0]!.text).toContain('notes/scope.md');
    const afterSecond = await store.readTask('cron', num);
    expect(afterSecond!.craftbook.steps.find((s) => s.id === entryStepId)!.redriveCount).toBe(1);
  });

  it('does NOT re-drive while the assignee is mid-turn', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setProjectVoorman('leo');
    await makeStalledTask({ now, agoMs: 30 * 60_000 });
    const chat = fakeChat();
    chat.setActiveGezels(['freja']); // assignee busy
    await makeScheduler(chat, now).sweepStuckSteps();
    expect(chat.delivered).toHaveLength(0);
  });

  it('does NOT re-drive a step that is not stale yet', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setProjectVoorman('leo');
    await makeStalledTask({ now, agoMs: 60_000 }); // 1 min < 8 min stall floor
    const chat = fakeChat();
    await makeScheduler(chat, now).sweepStuckSteps();
    expect(chat.delivered).toHaveLength(0);
  });

  it('pauses the task for a human once the re-drive budget is spent', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setProjectVoorman('leo');
    const { num } = await makeStalledTask({ now, agoMs: 30 * 60_000, redriveCount: 3 });
    const chat = fakeChat();
    await makeScheduler(chat, now).sweepStuckSteps();
    expect(chat.delivered).toHaveLength(0); // escalated, not re-driven
    expect((await store.readTask('cron', num))!.status).toBe('paused');
  });

  it('skips entirely under reactive engagement mode', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setProjectVoorman('leo');
    await makeStalledTask({ now, agoMs: 30 * 60_000 });
    await store.writeConfig({ aiEngagementMode: 'reactive' });
    const chat = fakeChat();
    await makeScheduler(chat, now).sweepStuckSteps();
    expect(chat.delivered).toHaveLength(0);
  });

  it('honors stuckStep.enabled = false', async () => {
    const now = new Date('2026-05-01T12:00:00Z');
    await setProjectVoorman('leo');
    await makeStalledTask({ now, agoMs: 30 * 60_000 });
    await store.writeConfig({ stuckStep: { enabled: false } });
    const chat = fakeChat();
    await makeScheduler(chat, now).sweepStuckSteps();
    expect(chat.delivered).toHaveLength(0);
  });
});

describe('TaskScheduler — engagement mode gates cron ticks', () => {
  it('skips cron ticks under reactive mode but fires under scheduled', async () => {
    const created = await tasks.create('cron', {
      title: 'Nightly check',
      assignee: { kind: 'user' },
      steps: [{ name: 'Main' }],
      cron: { expression: '0 9 * * *' },
    });
    // Force overdue
    const overdue = await store.readTask('cron', created.num);
    await store.writeTask({
      ...overdue!,
      cron: { expression: '0 9 * * *', nextTickAt: '2020-01-01T09:00:00Z' },
    });
    await store.writeConfig({ aiEngagementMode: 'reactive' });

    const scheduler = new TaskScheduler({ manager: tasks, store });
    await scheduler.tick();
    const ticksReactive = await history.listEvents({ kinds: ['task.tick'] });
    expect(ticksReactive).toHaveLength(0);

    // Flip to scheduled — now the tick should fire.
    await store.writeConfig({ aiEngagementMode: 'scheduled' });
    await scheduler.tick();
    const ticksScheduled = await history.listEvents({ kinds: ['task.tick'] });
    expect(ticksScheduled).toHaveLength(1);
  });
});
