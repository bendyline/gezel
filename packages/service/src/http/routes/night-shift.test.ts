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
});
