import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityStatusResponse, ListRequestsResponse } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let home: string;
let httpFetch: typeof fetch;
const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-requests-'));
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

async function get<T>(path: string): Promise<T> {
  const res = await httpFetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${svc.context.token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe('GET /api/requests', () => {
  it("answers a thread's request with one tracker, and Activity with one row", async () => {
    const ctx = svc.context;
    const gezel = await ctx.store.createGezel({ name: 'Wren', role: 'Meester' });
    const project = await ctx.store.createProject({ name: 'Bakery' });
    const thread = await ctx.chat.createSession({ gezelId: gezel.id, projectId: project.id });
    await ctx.chat.send(thread.id, 'Make my October invoices for the cafes');
    const task = await ctx.tasks.create(project.id, {
      title: 'October invoices',
      steps: [{ name: 'Draft the invoices' }, { name: 'Evaluate' }],
      assignee: { kind: 'gezel', gezelId: gezel.id },
      launchSessionId: thread.id,
    });

    const { requests } = await get<ListRequestsResponse>(`/api/requests?sessions=${thread.id}`);
    expect(requests).toEqual([
      expect.objectContaining({
        sessionId: thread.id,
        kind: 'work',
        summary: 'Make my October invoices for the cafes',
        stop: 'making',
        taskRefs: [task.ref],
      }),
    ]);
    expect(requests[0]?.key).toBe(`${thread.id}@${task.requestRef?.at}`);

    const elsewhere = await get<ListRequestsResponse>('/api/requests?sessions=nobody');
    expect(elsewhere.requests).toEqual([]);

    const activity = await get<ActivityStatusResponse>('/api/activity');
    const rows = activity.items.filter((i) => i.taskRef === task.ref || i.requestKey);
    expect(rows.map((r) => r.id)).toEqual([`request:${requests[0]?.key}`]);
  });
});
