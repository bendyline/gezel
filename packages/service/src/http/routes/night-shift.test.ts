import type { Task } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context.js';
import { nightShiftRoutes } from './night-shift.js';

function task(ref: string, title: string): Task {
  const [projectId, rawNum] = ref.split('/');
  const now = new Date().toISOString();
  return {
    projectId: projectId!,
    num: Number(rawNum),
    ref,
    title,
    status: 'active',
    assignee: { kind: 'gezel', gezelId: 'worker' },
    craftbook: {
      id: `book-${rawNum}`,
      name: title,
      steps: [{ id: 'work', name: 'Work', createdAt: now }],
      entryStepId: 'work',
      createdAt: now,
      updatedAt: now,
    },
    activeStepId: 'work',
    nightShift: { enabled: true },
    createdAt: now,
    updatedAt: now,
    createdBy: { kind: 'user' },
  };
}

describe('night-shift task status', () => {
  it('reports only real runner work and includes live indexing', async () => {
    const ctx = {
      nightShift: {
        isActive: () => true,
        listPendingTasks: async () => [
          task('p1/1', 'Running'),
          task('p1/2', 'Queued'),
          task('p1/3', 'Eligible but stranded'),
        ],
        quotaHeldTaskRefs: () => new Set<string>(),
      },
      chat: { activeTaskRefs: () => new Set(['p1/1']) },
      taskRunner: {
        workSnapshot: () => ({ queuedTaskRefs: ['p1/2'], dispatchedTaskRefs: [] }),
      },
      indexEnrichment: {
        getActivity: () => ({
          id: 'index-enrichment',
          title: 'Workspace indexing',
          detail: 'Studying workspace files',
          projectName: 'Project One',
        }),
      },
      store: { getProject: async () => ({ id: 'p1', name: 'Project One' }) },
    } as unknown as ServiceContext;

    const response = await nightShiftRoutes(ctx).request('/tasks');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      background: [
        {
          id: 'index-enrichment',
          title: 'Workspace indexing',
          detail: 'Studying workspace files',
          projectName: 'Project One',
        },
      ],
      active: [
        {
          ref: 'p1/1',
          title: 'Running',
          projectName: 'Project One',
          stepName: 'Work',
        },
      ],
      upcoming: [
        {
          ref: 'p1/2',
          title: 'Queued',
          projectName: 'Project One',
          stepName: 'Work',
        },
      ],
    });
  });

  // Handoffs parked for the night window are deliberately kept out of the
  // header's task queue, so this menu is the only place the user can see
  // that tonight's work is accounted for. Answering it only while a shift
  // runs would make the work invisible for the whole day.
  it('lists work queued for tonight while the shift is off', async () => {
    const ctx = {
      nightShift: {
        isActive: () => false,
        listPendingTasks: async () => [task('p1/2', 'Queued for tonight')],
        quotaHeldTaskRefs: () => new Set<string>(),
      },
      chat: { activeTaskRefs: () => new Set<string>() },
      taskRunner: {
        workSnapshot: () => ({ queuedTaskRefs: ['p1/2'], dispatchedTaskRefs: [] }),
      },
      indexEnrichment: {
        getActivity: () => ({ id: 'index-enrichment', title: 'Workspace indexing' }),
      },
      store: { getProject: async () => ({ id: 'p1', name: 'Project One' }) },
    } as unknown as ServiceContext;

    const response = await nightShiftRoutes(ctx).request('/tasks');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      // Daytime indexing belongs to the day, not to tonight's plan.
      background: [],
      active: [],
      upcoming: [
        {
          ref: 'p1/2',
          title: 'Queued for tonight',
          projectName: 'Project One',
          stepName: 'Work',
        },
      ],
    });
  });

  it('marks upcoming rows the quota reserve is holding', async () => {
    const ctx = {
      nightShift: {
        isActive: () => false,
        listPendingTasks: async () => [task('p1/2', 'Waiting on quota')],
        quotaHeldTaskRefs: () => new Set(['p1/2']),
      },
      chat: { activeTaskRefs: () => new Set<string>() },
      taskRunner: {
        workSnapshot: () => ({ queuedTaskRefs: ['p1/2'], dispatchedTaskRefs: [] }),
      },
      indexEnrichment: {
        getActivity: () => null,
      },
      store: { getProject: async () => ({ id: 'p1', name: 'Project One' }) },
    } as unknown as ServiceContext;

    const response = await nightShiftRoutes(ctx).request('/tasks');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { upcoming: Array<{ quotaHeld?: boolean }> };
    expect(body.upcoming[0]?.quotaHeld).toBe(true);
  });
});

describe('night-shift status', () => {
  const HOLD_STATUS = {
    heldTaskCount: 2,
    reasons: [
      {
        provider: 'copilot',
        bucket: 'premium_interactions',
        remainingPercent: 12,
        floorPercent: 20,
        rule: 'overall',
      },
    ],
  };

  const WINDOW = {
    start: '2026-07-29T22:00:00.000Z',
    end: '2026-07-30T06:00:00.000Z',
    open: false,
  };

  function statusCtx(quotaHold: typeof HOLD_STATUS | null): ServiceContext {
    return {
      nightShift: {
        isActive: () => false,
        source: () => null,
        quotaHoldStatus: () => quotaHold,
        windowBounds: () => WINDOW,
        startedAtIso: () => null,
      },
    } as unknown as ServiceContext;
  }

  it('embeds the quota-hold summary while work is parked by the reserve', async () => {
    const response = await nightShiftRoutes(statusCtx(HOLD_STATUS)).request('/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      active: false,
      source: null,
      window: WINDOW,
      startedAt: null,
      quotaHold: HOLD_STATUS,
    });
  });

  it('omits quotaHold entirely when nothing is held', async () => {
    const response = await nightShiftRoutes(statusCtx(null)).request('/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      active: false,
      source: null,
      window: WINDOW,
      startedAt: null,
    });
  });

  // The period the menu names has to come from the daemon: the UI can't
  // derive "when did this shift actually start" from the window hours —
  // a sleeping machine or mid-window work makes the two differ.
  it('names the running period with its own start', async () => {
    const ctx = {
      nightShift: {
        isActive: () => true,
        source: () => 'scheduled',
        quotaHoldStatus: () => null,
        windowBounds: () => ({ ...WINDOW, open: true }),
        startedAtIso: () => '2026-07-29T23:12:00.000Z',
      },
    } as unknown as ServiceContext;

    const body = (await (await nightShiftRoutes(ctx).request('/status')).json()) as {
      startedAt: string;
      window: { open: boolean };
    };
    expect(body.startedAt).toBe('2026-07-29T23:12:00.000Z');
    expect(body.window.open).toBe(true);
  });
});

describe('night-shift tally', () => {
  function tallyCtx(events: Array<{ kind: string; at: string; details?: unknown }>) {
    let historyCalls = 0;
    const ctx = {
      nightShift: {
        isActive: () => true,
        currentWindow: () => ({ startHour: 22, endHour: 6 }),
        startedAtIso: () => new Date(Date.now() - 60 * 60_000).toISOString(),
      },
      history: {
        listEvents: async () => {
          historyCalls++;
          return events;
        },
      },
      store: { listProjects: async () => [{ id: 'p1' }] },
      contentIndex: {
        workCountsSince: async () => ({ summarized: 42, reviewed: 7, described: 2 }),
      },
    } as unknown as ServiceContext;
    return { ctx, calls: () => historyCalls };
  }

  it('counts the finished work of the period across the log and the index', async () => {
    const at = new Date().toISOString();
    const { ctx } = tallyCtx([
      { kind: 'task.status.changed', at, details: { status: 'complete' } },
      { kind: 'task.status.changed', at, details: { status: 'paused' } },
      { kind: 'task.step.completed', at },
      { kind: 'workspace.write', at },
      { kind: 'tool.called', at },
    ]);

    const body = (await (await nightShiftRoutes(ctx).request('/tally')).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      live: true,
      tasksCompleted: 1,
      stepsCompleted: 1,
      filesWritten: 1,
      toolCalls: 1,
      filesIndexed: 42,
      filesReviewed: 7,
      mediaDescribed: 2,
    });
  });

  // The menu polls every 5s; the build behind it sweeps the audit log and
  // opens every project's index.
  it('memoizes the build across a poll cadence', async () => {
    const { ctx, calls } = tallyCtx([]);
    const routes = nightShiftRoutes(ctx);
    await routes.request('/tally');
    await routes.request('/tally');
    expect(calls()).toBe(1);
  });
});
