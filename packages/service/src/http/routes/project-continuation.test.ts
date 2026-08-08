import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../context.js';
import { projectContinuationRoutes } from './project-continuation.js';

describe('project continuation route', () => {
  it('scopes schedule processing and active-task reconciliation to the project', async () => {
    const calls: string[] = [];
    const ctx = {
      store: {
        getProject: vi.fn(async () => ({ id: 'p1', name: 'Project One', status: 'active' })),
      },
      taskRunner: {
        rehydrateFromStore: vi.fn(async (opts: { projectId?: string }) => {
          calls.push(`rehydrate:${opts.projectId}`);
          return {
            taskRefs: ['p1/1', 'p1/2'],
            nightShiftTaskRefs: ['p1/2'],
          };
        }),
        wake: vi.fn(async () => {
          calls.push('wake');
        }),
        snapshot: vi.fn(() => ({
          pendingCount: 1,
          pendingByGezel: { bea: 1 },
          pendingByProject: { p1: 1 },
          dispatchable: { count: 1, byGezel: { bea: 1 } },
          scheduled: { count: 0, byGezel: {} },
          holdReason: 'provider-busy' as const,
        })),
      },
      taskScheduler: {
        tickCrons: vi.fn(async (opts: { projectId?: string }) => {
          calls.push(`schedules:${opts.projectId}`);
          return {
            processedTaskRefs: ['p1/3'],
            heldTaskRefs: [],
            spawnedTaskRefs: ['p1/4'],
          };
        }),
      },
      nightShift: { isActive: () => false },
    } as unknown as ServiceContext;

    const response = await projectContinuationRoutes(ctx).request('/p1/continue', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(['rehydrate:p1', 'schedules:p1', 'wake']);
    expect(await response.json()).toEqual({
      projectId: 'p1',
      projectStatus: 'active',
      scheduledTaskRefs: ['p1/3'],
      heldScheduledTaskRefs: [],
      spawnedTaskRefs: ['p1/4'],
      activeTaskRefs: ['p1/1', 'p1/2'],
      deferredNightShiftTaskRefs: ['p1/2'],
      holdReason: 'provider-busy',
    });
  });

  it('returns 404 without touching the schedulers for an unknown project', async () => {
    const ctx = {
      store: { getProject: async () => null },
      taskRunner: { rehydrateFromStore: vi.fn() },
      taskScheduler: { tickCrons: vi.fn() },
    } as unknown as ServiceContext;

    const response = await projectContinuationRoutes(ctx).request('/missing/continue', {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(ctx.taskRunner.rehydrateFromStore).not.toHaveBeenCalled();
    expect(ctx.taskScheduler.tickCrons).not.toHaveBeenCalled();
  });
});
