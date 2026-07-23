import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSession } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let httpFetch: typeof fetch;
let home: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

function session(over: Partial<ChatSession> & Pick<ChatSession, 'id' | 'projectId'>): ChatSession {
  return {
    version: 1,
    gezelId: 'tester',
    providerName: 'copilot',
    title: over.id,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActivityAt: '2026-07-01T00:00:00.000Z',
    messages: [],
    providerState: {},
    ...over,
  } as ChatSession;
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-poisoned-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;

  const store = svc.context.store;
  // proj-a: a live poisoned session → reported.
  await store.writeSession(
    session({
      id: 'a-bad',
      projectId: 'proj-a',
      lastTurnError: 'boom',
      lastActivityAt: '2026-07-01T10:00:00.000Z',
    }),
  );
  // proj-b: errored but archived → excluded.
  await store.writeSession(
    session({ id: 'b-bad', projectId: 'proj-b', lastTurnError: 'boom', archived: true }),
  );
  // proj-c: clean → excluded.
  await store.writeSession(session({ id: 'c-ok', projectId: 'proj-c' }));
  // proj-d: a newer clean session + an older errored one → still reported,
  // with the errored session as the representative.
  await store.writeSession(
    session({ id: 'd-ok', projectId: 'proj-d', lastActivityAt: '2026-07-01T12:00:00.000Z' }),
  );
  await store.writeSession(
    session({
      id: 'd-bad',
      projectId: 'proj-d',
      lastTurnError: 'context overflow',
      lastActivityAt: '2026-07-01T09:00:00.000Z',
    }),
  );
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('GET /api/projects/poisoned', () => {
  it('reports non-archived errored sessions, one representative per project', async () => {
    const res = await httpFetch(`${baseUrl}/api/projects/poisoned`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      poisoned: Array<{ projectId: string; sessionId: string; gezelId: string; error: string }>;
    };
    const byProject = new Map(body.poisoned.map((p) => [p.projectId, p]));

    // proj-a is poisoned; proj-b (archived) and proj-c (clean) are not.
    expect(byProject.get('proj-a')).toMatchObject({ sessionId: 'a-bad', error: 'boom' });
    expect(byProject.has('proj-b')).toBe(false);
    expect(byProject.has('proj-c')).toBe(false);
    // proj-d reports the errored session even though a newer clean one exists.
    expect(byProject.get('proj-d')).toMatchObject({
      sessionId: 'd-bad',
      error: 'context overflow',
    });
  });

  it('POST /api/projects/:id/clear-errors un-poisons the whole project', async () => {
    const clear = await httpFetch(`${baseUrl}/api/projects/proj-a/clear-errors`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ cleared: 1 });

    const res = await httpFetch(`${baseUrl}/api/projects/poisoned`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { poisoned: Array<{ projectId: string }> };
    // proj-a is cleared; proj-d (a different project) is untouched.
    expect(body.poisoned.some((p) => p.projectId === 'proj-a')).toBe(false);
    expect(body.poisoned.some((p) => p.projectId === 'proj-d')).toBe(true);
  });
});
