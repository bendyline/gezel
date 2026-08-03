import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from './service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let gezelId: string;
let httpFetch: typeof fetch;

// `startService` boots the full daemon (HTTPS cert gen, store layout,
// secret store, optional MLX/llama-cpp probes). In isolation it's ~1s,
// but several integration files boot one in parallel under
// `pnpm test`, and contention pushes the 10s default over the cliff.
// Match the 30s timeout that other startService-driven integration
// tests (mcp-bridge.test.ts) use for the same reason.
beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  const home = await mkdtemp(join(tmpdir(), 'gezel-sess-integ-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  // Create one gezel the tests share.
  const res = await httpFetch(`${baseUrl}/api/gezels`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Ada', role: 'Developer' }),
  });
  const created = (await res.json()) as { id: string };
  gezelId = created.id;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(svc.context.home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
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

describe('sessions API — CRUD', () => {
  it('creates + lists + fetches a session', async () => {
    const create = await api('POST', '/api/sessions', { gezelId });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; title: string };
    expect(created.id).toBeTruthy();

    const list = await (await api('GET', `/api/sessions?gezel=${gezelId}`)).json();
    const ids = (list as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    expect(ids).toContain(created.id);

    const fetched = (await (await api('GET', `/api/sessions/${created.id}`)).json()) as {
      id: string;
    };
    expect(fetched.id).toBe(created.id);
  });

  it('filters by projectId', async () => {
    const defaultList = (await (
      await api('GET', `/api/sessions?gezel=${gezelId}&project=default`)
    ).json()) as {
      sessions: Array<{ projectId: string }>;
    };
    for (const s of defaultList.sessions) {
      expect(s.projectId).toBe('default');
    }
  });

  it('archive flips the archived flag', async () => {
    const created = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };
    const archived = (await (await api('POST', `/api/sessions/${created.id}/archive`)).json()) as {
      archived?: boolean;
    };
    expect(archived.archived).toBe(true);
  });

  it('delete removes the session', async () => {
    const created = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };
    const del = await api('DELETE', `/api/sessions/${created.id}`);
    expect(del.status).toBe(200);
    const fetchAgain = await api('GET', `/api/sessions/${created.id}`);
    expect(fetchAgain.status).toBe(404);
  });
});

describe('sessions API — send + events', () => {
  it('accepts a send and streams a response via SSE', async () => {
    const created = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };

    // Open SSE stream.
    const controller = new AbortController();
    const sseRes = await httpFetch(`${baseUrl}/events/chat?session=${created.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(sseRes.ok).toBe(true);

    // Fire the send in parallel.
    const sendPromise = api('POST', `/api/sessions/${created.id}/send`, { message: 'hello mock' });

    // Read events until we see 'done'.
    const events: Array<{ type: string; content?: string }> = [];
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const ev = JSON.parse(payload) as { type: string; content?: string };
          events.push(ev);
          if (ev.type === 'done') break;
        } catch {
          /* ignore keepalives */
        }
      }
      if (events.some((e) => e.type === 'done')) break;
    }
    controller.abort();
    await sendPromise;

    const types = events.map((e) => e.type);
    expect(types).toContain('delta');
    expect(types).toContain('complete');
    expect(types).toContain('done');

    // Session should now have persisted messages.
    const full = (await (await api('GET', `/api/sessions/${created.id}`)).json()) as {
      messages: Array<{ role: string; content: string }>;
      title: string;
    };
    expect(full.messages.some((m) => m.role === 'user' && m.content === 'hello mock')).toBe(true);
    expect(full.messages.some((m) => m.role === 'assistant')).toBe(true);
    expect(full.title).toBe('hello mock');
  }, 15_000);
});

describe('sessions API — queue + interrupt', () => {
  it('GET /:id/queue on an idle session returns an empty list', async () => {
    const created = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };
    const res = await api('GET', `/api/sessions/${created.id}/queue`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: created.id, entries: [] });
  });

  it('PATCH /:id/queue/:queueId 404s when the entry does not exist', async () => {
    const created = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };
    const res = await api('PATCH', `/api/sessions/${created.id}/queue/no-such-id`, {
      message: 'edited',
    });
    expect(res.status).toBe(404);
  });

  it('POST /:id/interrupt on an idle session degrades to a plain send', async () => {
    const created = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };
    const res = await api('POST', `/api/sessions/${created.id}/interrupt`, {
      message: 'interrupt with nothing to interrupt',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, sessionId: created.id });

    // The message went straight through as a normal turn.
    const deadline = Date.now() + 8_000;
    let messages: Array<{ role: string; content: string; nudge?: boolean }> = [];
    while (Date.now() < deadline) {
      const full = (await (await api('GET', `/api/sessions/${created.id}`)).json()) as {
        messages: typeof messages;
      };
      messages = full.messages;
      if (messages.some((m) => m.role === 'assistant')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const user = messages.find((m) => m.role === 'user');
    expect(user?.content).toBe('interrupt with nothing to interrupt');
    expect(user?.nudge).toBeUndefined();
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);
  }, 12_000);

  it('POST /:id/send with nudge on an idle session persists without the marker', async () => {
    const created = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };
    const res = await api('POST', `/api/sessions/${created.id}/send`, {
      message: 'nudge that never queued',
      nudge: true,
    });
    expect(res.status).toBe(202);

    const deadline = Date.now() + 8_000;
    let messages: Array<{ role: string; content: string; nudge?: boolean }> = [];
    while (Date.now() < deadline) {
      const full = (await (await api('GET', `/api/sessions/${created.id}`)).json()) as {
        messages: typeof messages;
      };
      messages = full.messages;
      if (messages.some((m) => m.role === 'assistant')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const user = messages.find((m) => m.role === 'user');
    expect(user?.content).toBe('nudge that never queued');
    expect(user?.nudge).toBeUndefined();
  }, 12_000);
});

describe('sessions API — back-compat', () => {
  it('legacy /api/gezels/:id/chat resolves to most-recent session', async () => {
    // Send via legacy endpoint — should create + route to most-recent session.
    const res = await api('POST', `/api/gezels/${gezelId}/chat/send`, { message: 'legacy ping' });
    expect(res.status).toBe(202);
    const payload = (await res.json()) as { sessionId: string };
    expect(payload.sessionId).toBeTruthy();

    // Wait for the reply to land.
    await new Promise((r) => setTimeout(r, 500));

    const history = (await (await api('GET', `/api/gezels/${gezelId}/chat`)).json()) as {
      messages: Array<{ role: string }>;
    };
    expect(history.messages.length).toBeGreaterThan(0);
  }, 10_000);
});
