import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@bendyline/gezel';
import { GezelClient } from '@bendyline/gezel-client';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let client: GezelClient;
let home: string;
let gezelId: string;
let projectId: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-timeline-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  const baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  client = new GezelClient({ baseUrl, token: svc.context.token, fetch: httpFetch });

  const gezel = await svc.context.store.createGezel({ name: 'Tomas', role: 'Voorman' });
  gezelId = gezel.id;
  const project = await client.createProject({ name: 'Molen Internal' });
  projectId = project.id;

  const base = (id: string, at: string, content: string): ChatSession => ({
    version: 1,
    id,
    gezelId,
    projectId,
    providerName: 'copilot',
    model: 'mock-fast',
    title: content,
    createdAt: at,
    lastActivityAt: at,
    messages: [{ role: 'user', content, at }],
    providerState: {},
  });

  await svc.context.store.writeSession({
    ...base('sess-task-1', '2026-04-14T10:00:00Z', 'about the contract review'),
    taskRef: `${projectId}/1`,
  });
  await svc.context.store.writeSession({
    ...base('sess-task-2', '2026-04-14T10:00:01Z', 'about a different task'),
    taskRef: `${projectId}/2`,
  });
  await svc.context.store.writeSession(
    base('sess-unscoped', '2026-04-14T10:00:02Z', 'general project check-in'),
  );
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('GET /api/projects/:id/timeline', () => {
  it('returns every session in the project when unscoped', async () => {
    const res = await client.listProjectTimeline(projectId);
    expect(res.messages.map((m) => m.content).sort()).toEqual([
      'about a different task',
      'about the contract review',
      'general project check-in',
    ]);
  });

  it('narrows to one task when ?task= is set', async () => {
    const res = await client.listProjectTimeline(projectId, { taskRef: `${projectId}/1` });
    expect(res.messages.map((m) => m.content)).toEqual(['about the contract review']);
  });

  it('returns nothing for a task with no sessions rather than falling back to the project', async () => {
    const res = await client.listProjectTimeline(projectId, { taskRef: `${projectId}/99` });
    expect(res.messages).toEqual([]);
  });
});
