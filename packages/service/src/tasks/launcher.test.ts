import type { Task, TaskReferences } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type TaskLaunchDeps, type TaskLaunchRequest, TaskLauncher } from './launcher.js';

const deckSchema = {
  type: 'object',
  properties: { topic: { type: 'string' }, sourcePath: { type: 'string' } },
};

const REFERENCES: TaskReferences = {
  subject: 'quiche',
  gatheredAt: '2026-09-26T00:10:53.000Z',
  items: [{ source: 'knowledge', title: 'Quiche', uri: 'knowledge://bendyline/food/290627' }],
};

function harness(gather?: TaskLaunchDeps['gatherReferences']) {
  const creates: Array<{ body: TaskLaunchRequest; extras?: { references?: TaskReferences } }> = [];
  const gathered: Array<{ projectId: string; subject: string; craftbookName: string }> = [];
  const deps = {
    tasks: {
      create: async (
        _projectId: string,
        body: TaskLaunchRequest,
        extras?: { references?: TaskReferences },
      ) => {
        creates.push({ body, ...(extras ? { extras } : {}) });
        // Paused, so the entry dispatch returns before touching a runner.
        return { ref: 'p1/1', num: 1, projectId: 'p1', status: 'paused' } as unknown as Task;
      },
      list: async () => [],
      describeCraftbook: async () => ({ name: 'PowerPoint from Content', paramSchema: deckSchema }),
    },
    store: { getProject: async () => null, getGezel: async () => null },
    taskRunner: { enqueueHandoff: async () => {} },
    gatherReferences:
      gather ??
      (async (args: { projectId: string; subject: string; craftbookName: string }) => {
        gathered.push(args);
        return REFERENCES;
      }),
  } as unknown as TaskLaunchDeps;
  return { launcher: new TaskLauncher(deps), creates, gathered };
}

function deck(params: Record<string, string>): TaskLaunchRequest {
  return {
    title: 'PowerPoint from Content',
    description: 'Can you create a PowerPoint about quiche',
    craftbookId: 'powerpoint-deck',
    craftbookParams: params,
  };
}

describe('TaskLauncher reference list', () => {
  it('stamps the list on a book started from the get-go, in the create write', async () => {
    const { launcher, creates, gathered } = harness();
    await launcher.launch('p1', deck({ topic: 'quiche' }), { dispatchEntry: true });
    expect(gathered).toEqual([
      { projectId: 'p1', subject: 'quiche', craftbookName: 'PowerPoint from Content' },
    ]);
    expect(creates[0]?.extras?.references).toEqual(REFERENCES);
  });

  it('does not search for a task nobody starts, or one that brings its own source', async () => {
    const { launcher, creates, gathered } = harness();
    await launcher.launch('p1', deck({ topic: 'quiche' }));
    await launcher.launch('p1', deck({ topic: 'quiche', sourcePath: 'brief.docx' }), {
      dispatchEntry: true,
    });
    await launcher.launch(
      'p1',
      { ...deck({ topic: 'quiche' }), status: 'draft' },
      {
        dispatchEntry: true,
      },
    );
    expect(gathered).toEqual([]);
    expect(creates.every((create) => create.extras?.references === undefined)).toBe(true);
  });

  it('searches once when a repeated launch coalesces onto the first', async () => {
    const { launcher, creates, gathered } = harness();
    const key = 'invocation-1';
    await Promise.all([
      launcher.launch('p1', deck({ topic: 'quiche' }), {
        dispatchEntry: true,
        craftbookInvocationKey: key,
      }),
      launcher.launch('p1', deck({ topic: 'quiche' }), {
        dispatchEntry: true,
        craftbookInvocationKey: key,
      }),
    ]);
    expect(gathered).toHaveLength(1);
    expect(creates).toHaveLength(1);
  });

  it('still launches when the search fails', async () => {
    const { launcher, creates } = harness(async () => {
      throw new Error('index offline');
    });
    await launcher.launch('p1', deck({ topic: 'quiche' }), { dispatchEntry: true });
    expect(creates).toHaveLength(1);
    expect(creates[0]?.extras?.references).toBeUndefined();
  });
});
