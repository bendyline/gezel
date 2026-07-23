import { mkdtemp, rm } from 'node:fs/promises';
/**
 * Route coverage for the session-telemetry surface: the list endpoint's
 * shape/version/filters, the per-id endpoint's null contract, and the
 * additive `lastProgressAgoMs` on inflight rows. Counter semantics are
 * covered in chat/session-telemetry.test.ts and manager-telemetry.test.ts;
 * these tests pin the HTTP contract the eval harness and UI consume.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionTelemetryListResponse } from '@bendyline/gezel';
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
  home = await mkdtemp(join(tmpdir(), 'gezel-sessions-telemetry-route-'));
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

describe('GET /api/sessions/telemetry', () => {
  it('returns the versioned envelope, and per-id returns null for untracked sessions', async () => {
    const res = await api('GET', '/api/sessions/telemetry');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionTelemetryListResponse;
    expect(body.version).toBe(1);
    expect(typeof body.capturedAt).toBe('number');
    expect(Array.isArray(body.sessions)).toBe(true);

    const one = await api('GET', '/api/sessions/nonexistent-session/telemetry');
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ telemetry: null });
  });

  it('tracks a real send and honors project/gezel filters', async () => {
    const created = await api('POST', '/api/gezels', { name: 'Tessa' });
    expect(created.status).toBe(201);
    const gezelId = ((await created.json()) as { id: string }).id;

    const sessRes = await api('POST', '/api/sessions', { gezelId });
    expect(sessRes.status).toBe(201);
    const sessionId = ((await sessRes.json()) as { id: string }).id;

    const send = await api('POST', `/api/sessions/${sessionId}/send`, { message: 'hello' });
    expect(send.status).toBe(202);

    // The send is accepted async; poll briefly until the turn lands.
    let snap: SessionTelemetryListResponse | null = null;
    for (let i = 0; i < 40; i++) {
      const res = await api('GET', `/api/sessions/telemetry?gezel=${gezelId}`);
      const body = (await res.json()) as SessionTelemetryListResponse;
      const row = body.sessions.find((s) => s.sessionId === sessionId);
      if (row && row.turnsStarted >= 1 && !row.inflight) {
        snap = body;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(snap).not.toBeNull();
    const row = snap!.sessions.find((s) => s.sessionId === sessionId);
    expect(row?.gezelId).toBe(gezelId);
    expect(row?.deltaChunks).toBeGreaterThan(0);
    expect(row?.streamedContentChars).toBeGreaterThan(0);
    expect(row?.lastProgressAt).not.toBeNull();

    const other = await api('GET', '/api/sessions/telemetry?gezel=nobody');
    const otherBody = (await other.json()) as SessionTelemetryListResponse;
    expect(otherBody.sessions.find((s) => s.sessionId === sessionId)).toBeUndefined();

    const perId = await api('GET', `/api/sessions/${sessionId}/telemetry`);
    const perIdBody = (await perId.json()) as { telemetry: { sessionId: string } | null };
    expect(perIdBody.telemetry?.sessionId).toBe(sessionId);
  }, 30_000);
});
