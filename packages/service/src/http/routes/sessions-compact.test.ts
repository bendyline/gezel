import { mkdtemp, rm } from 'node:fs/promises';
/**
 * Route coverage for on-demand compaction — the context meter's "Compact now".
 * The collapse itself is covered in chat/manager.test.ts; this pins the HTTP
 * contract, in particular that a refusal is a 409 carrying a coded, readable
 * reason rather than a bare error the popover would show verbatim.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-sessions-compact-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function api(method: string, path: string, body?: unknown) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/sessions/:id/compact', () => {
  it('refuses a thread with nothing older to fold, in words the popover can show', async () => {
    const created = await api('POST', '/api/gezels', { name: 'Wendel' });
    expect(created.status).toBe(201);
    const gezelId = ((await created.json()) as { id: string }).id;

    const session = await api('POST', '/api/sessions', { gezelId });
    expect(session.status).toBe(201);
    const sessionId = ((await session.json()) as { id: string }).id;

    const res = await api('POST', `/api/sessions/${sessionId}/compact`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('too-short');
    expect(body.error).toMatch(/too short to compact/);
  });

  it('404s for a session that does not exist', async () => {
    const res = await api('POST', '/api/sessions/nope/compact');
    expect(res.status).toBe(404);
  });
});
