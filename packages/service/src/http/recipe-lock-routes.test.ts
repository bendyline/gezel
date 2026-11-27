import type { Task, TaskCraftbookStep } from '@bendyline/gezel';
import { errorToResponse } from '@bendyline/gezel/runtime';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from './context.js';
import { projectTaskRoutes } from './routes/project-tasks.js';

/**
 * A started task's checks and routing are the bar its work is judged by, so
 * a gezel's session may add to the recipe but not weaken it.
 * `session-recipe-guard.test.ts` pins the rule as a function; this pins that
 * each of the five routes that edit a recipe actually applies it before
 * writing, and that the person's own app is not limited.
 */

const GATE = { checks: [{ kind: 'fileExists', path: 'out/report.md' }] };

function startedTask(): Task {
  return {
    projectId: 'p1',
    num: 1,
    ref: 'p1/1',
    status: 'active',
    craftbook: {
      id: 'cb',
      name: 'Recipe',
      entryStepId: 'draft',
      steps: [
        { id: 'draft', name: 'Draft', gate: GATE, next: 'review' },
        { id: 'review', name: 'Review', terminal: true },
      ] as unknown as TaskCraftbookStep[],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  } as unknown as Task;
}

const SESSION = {
  appId: 'session:s1',
  scopes: ['session'],
  projectId: 'p1',
  gezelId: 'gz-1',
  team: true,
};
const OWNER = { appId: 'root', scopes: ['root'] };

function harness(auth: Record<string, unknown>) {
  const writes = {
    updateStep: vi.fn(async () => startedTask()),
    removeStep: vi.fn(async () => startedTask()),
    reorderSteps: vi.fn(async () => startedTask()),
    updateCraftbookMeta: vi.fn(async () => startedTask()),
    replaceCraftbook: vi.fn(async () => startedTask()),
  };
  const ctx = {
    tasks: { get: vi.fn(async () => startedTask()), ...writes },
  } as unknown as ServiceContext;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth as never);
    await next();
  });
  app.route('/api/projects', projectTaskRoutes(ctx));
  app.onError((err, c) => {
    const reply = errorToResponse(err, { exposeUnknown: true });
    return c.json(reply.body, reply.status as 400);
  });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api/projects/p1/tasks/1${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  return { send, writes };
}

/** A document that drops the gate the task started with. */
const WEAKENED_DOC = JSON.stringify({
  name: 'Recipe',
  entryStepId: 'draft',
  steps: [
    { id: 'draft', name: 'Draft', prompt: 'Draft it.', next: 'review' },
    { id: 'review', name: 'Review', prompt: 'Review it.', terminal: true },
  ],
});

const EDITS: Array<{
  name: string;
  method: string;
  path: string;
  body?: unknown;
  write: keyof ReturnType<typeof harness>['writes'];
}> = [
  {
    name: 'drop a step’s gate',
    method: 'PATCH',
    path: '/steps/draft',
    body: { gate: null },
    write: 'updateStep',
  },
  { name: 'remove a step', method: 'DELETE', path: '/steps/review', write: 'removeStep' },
  {
    name: 'reorder the steps',
    method: 'PATCH',
    path: '/craftbook/steps/order',
    body: { order: ['review', 'draft'] },
    write: 'reorderSteps',
  },
  {
    name: 'move the first step',
    method: 'PATCH',
    path: '/craftbook',
    body: { entryStepId: 'review' },
    write: 'updateCraftbookMeta',
  },
  {
    name: 'replace the recipe with a weaker document',
    method: 'PUT',
    path: '/craftbook/document',
    body: { content: WEAKENED_DOC, format: 'json' },
    write: 'replaceCraftbook',
  },
];

describe('recipe lock on the task routes', () => {
  it.each(EDITS)('refuses a session that tries to $name, and writes nothing', async (edit) => {
    const { send, writes } = harness(SESSION);
    const res = await send(edit.method, edit.path, edit.body);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('recipe_locked');
    expect(writes[edit.write]).not.toHaveBeenCalled();
  });

  it.each(EDITS)('lets the person’s own app $name', async (edit) => {
    const { send, writes } = harness(OWNER);
    const res = await send(edit.method, edit.path, edit.body);
    expect(res.status).toBe(200);
    expect(writes[edit.write]).toHaveBeenCalledTimes(1);
  });

  it('still lets a session refine a step without weakening it', async () => {
    const { send, writes } = harness(SESSION);
    const res = await send('PATCH', '/steps/review', { prompt: 'Read it twice.' });
    expect(res.status).toBe(200);
    expect(writes.updateStep).toHaveBeenCalledTimes(1);
  });
});
