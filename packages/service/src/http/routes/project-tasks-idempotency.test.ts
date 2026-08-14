import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
let projectId: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-task-idempotency-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  projectId = (await svc.context.store.createProject({ name: 'Idempotency' })).id;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function createTask(body: unknown) {
  return httpFetch(`${baseUrl}/api/projects/${projectId}/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('craftbook root-turn task idempotency', () => {
  it('returns the first active task for a repeated invocation key', async () => {
    const body = {
      title: 'Build the game',
      description: 'Build and validate the requested game inside the current project workspace.',
      steps: [{ name: 'Build' }],
      craftbookInvocationKey: `craftbook-root-v1:${'a'.repeat(64)}`,
    };

    const firstResponse = await createTask(body);
    const secondResponse = await createTask(body);
    const first = (await firstResponse.json()) as Task;
    const second = (await secondResponse.json()) as Task;

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(200);
    expect(second.ref).toBe(first.ref);
    expect(first.origin).toEqual({
      kind: 'craftbook-invocation',
      key: body.craftbookInvocationKey,
    });
    expect(await svc.context.tasks.list({ projectId })).toHaveLength(1);
  });

  it('coalesces concurrent requests before the first task write finishes', async () => {
    const body = {
      title: 'Build another game',
      description: 'Build and validate another requested game in this same project workspace.',
      steps: [{ name: 'Build' }],
      craftbookInvocationKey: `craftbook-root-v1:${'b'.repeat(64)}`,
    };

    const [aResponse, bResponse] = await Promise.all([createTask(body), createTask(body)]);
    const [a, b] = (await Promise.all([aResponse.json(), bResponse.json()])) as [Task, Task];

    expect([aResponse.status, bResponse.status].sort()).toEqual([200, 201]);
    expect(a.ref).toBe(b.ref);
    expect(await svc.context.tasks.list({ projectId })).toHaveLength(2);
  });
});
