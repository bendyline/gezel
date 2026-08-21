import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListTasksResponse } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
let projectId: string;
let gezelId: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-task-waiting-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  projectId = (await svc.context.store.createProject({ name: 'Waiting' })).id;
  gezelId = (await svc.context.store.createGezel({ name: 'Koray' })).id;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

async function listActiveTasks(): Promise<ListTasksResponse> {
  const res = await httpFetch(`${baseUrl}/api/projects/${projectId}/tasks?status=active`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ListTasksResponse;
}

describe('GET /api/projects/:id/tasks — runner wait state', () => {
  it('reports an active task the runner is not holding as not waiting', async () => {
    const task = await svc.context.tasks.create(projectId, {
      title: 'Nothing enqueued this one',
      steps: [{ name: 'Plan', assignee: { kind: 'gezel', gezelId } }],
      assignee: { kind: 'gezel', gezelId },
    });

    const body = await listActiveTasks();
    expect(body.tasks.map((t) => t.ref)).toContain(task.ref);
    expect(body.waiting ?? []).toEqual([]);
  });

  it('names the queued task, its gezel, and why it has not started', async () => {
    const task = await svc.context.tasks.create(projectId, {
      title: 'Queued behind other work',
      steps: [{ name: 'Plan', assignee: { kind: 'gezel', gezelId } }],
      assignee: { kind: 'gezel', gezelId },
    });
    svc.context.taskRunner.enqueueHandoff({
      taskRef: task.ref,
      stepId: task.activeStepId ?? task.craftbook.steps[0]!.id,
      gezelId,
      projectId,
    });

    const body = await listActiveTasks();
    const waiting = (body.waiting ?? []).find((state) => state.ref === task.ref);
    expect(waiting).toBeDefined();
    expect(waiting?.gezelId).toBe(gezelId);
    expect(waiting?.reason).toBe('queued');
    expect(Number.isNaN(Date.parse(waiting?.since ?? ''))).toBe(false);
  });

  it('scopes the wait list to the tasks in the response', async () => {
    const other = await svc.context.store.createProject({ name: 'Elsewhere' });
    const otherTask = await svc.context.tasks.create(other.id, {
      title: 'Another project entirely',
      steps: [{ name: 'Plan', assignee: { kind: 'gezel', gezelId } }],
      assignee: { kind: 'gezel', gezelId },
    });
    svc.context.taskRunner.enqueueHandoff({
      taskRef: otherTask.ref,
      stepId: otherTask.activeStepId ?? otherTask.craftbook.steps[0]!.id,
      gezelId,
      projectId: other.id,
    });

    const body = await listActiveTasks();
    expect((body.waiting ?? []).map((state) => state.ref)).not.toContain(otherTask.ref);
  });
});
