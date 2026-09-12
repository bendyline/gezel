import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppToolRelayEvent } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let home: string;
let httpFetch: typeof fetch;
let appToken: string;
let otherToken: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

const TOOL = {
  name: 'add_travel_points',
  description: 'Award travel points to the traveller.',
  inputSchema: { type: 'object', properties: { points: { type: 'number' } } },
};

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-app-tools-routes-'));
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  appToken = (
    await svc.context.tokenStore.issue({
      appId: 'qualla',
      appName: 'Qualla',
      scopes: ['product'],
    })
  ).token;
  otherToken = (
    await svc.context.tokenStore.issue({
      appId: 'rival',
      appName: 'Rival',
      scopes: ['product'],
    })
  ).token;
}, 30_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<Response> {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function openRelay(token = appToken): Promise<string> {
  const res = await api('POST', '/api/app-tools/relays', { token, body: {} });
  expect(res.status).toBe(201);
  return ((await res.json()) as { relayId: string }).relayId;
}

/** Read relay events until `stop` says we have what the test needs. */
async function readEvents(
  relayId: string,
  stop: (event: AppToolRelayEvent) => boolean,
  token = appToken,
): Promise<{ events: AppToolRelayEvent[]; close: () => void }> {
  const controller = new AbortController();
  const res = await httpFetch(`${baseUrl}/api/app-tools/relays/${relayId}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const events: AppToolRelayEvent[] = [];
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no event stream body');
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (data) {
          const event = JSON.parse(data) as AppToolRelayEvent;
          events.push(event);
          if (stop(event)) return;
        }
        cut = buffer.indexOf('\n\n');
      }
    }
  })();
  await pump;
  return { events, close: () => controller.abort() };
}

describe('/api/app-tools', () => {
  it('opens a relay, announces readiness, and registers tools for a project', async () => {
    const relayId = await openRelay();
    const stream = await readEvents(relayId, (event) => event.type === 'ready');
    try {
      expect(stream.events[0]).toMatchObject({ type: 'ready', relayId });

      const registered = await api('PUT', `/api/app-tools/relays/${relayId}/tools`, {
        token: appToken,
        body: { projectId: 'default', tools: [TOOL] },
      });
      expect(registered.status).toBe(200);
      expect(await registered.json()).toMatchObject({
        ok: true,
        toolsetId: 'app-tools:qualla',
        registered: ['add_travel_points'],
      });

      const listed = await api('GET', '/api/app-tools/relays', { token: appToken });
      expect(await listed.json()).toMatchObject({
        relays: [{ relayId, appId: 'qualla', connected: true }],
      });
    } finally {
      stream.close();
      await api('DELETE', `/api/app-tools/relays/${relayId}`, { token: appToken });
    }
  }, 20_000);

  it('carries a live call to the app and takes its result back', async () => {
    const relayId = await openRelay();
    const ready = await readEvents(relayId, (event) => event.type === 'ready');
    ready.close();
    await api('PUT', `/api/app-tools/relays/${relayId}/tools`, {
      token: appToken,
      body: { projectId: 'default', tools: [TOOL] },
    });

    // Re-attach, then drive a call through the registry as a session would.
    const pending = readEvents(relayId, (event) => event.type === 'tool_call');
    // Give the stream a moment to attach before the call is emitted.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const binding = svc.context.appToolRelays.listForSession({
      projectId: 'default',
      gezelId: 'ada',
    })[0];
    if (!binding) throw new Error('no binding registered');
    const invocation = svc.context.appToolRelays.invoke(binding, {
      tool: 'add_travel_points',
      args: { points: 3 },
      sessionId: 's1',
      gezelId: 'ada',
      projectId: 'default',
    });

    const stream = await pending;
    const call = stream.events.find((event) => event.type === 'tool_call');
    if (!call || call.type !== 'tool_call') throw new Error('no tool_call received');
    expect(call).toMatchObject({ tool: 'add_travel_points', arguments: { points: 3 } });

    const posted = await api(
      'POST',
      `/api/app-tools/relays/${relayId}/calls/${call.callId}/result`,
      { token: appToken, body: { ok: true, content: 'awarded 3' } },
    );
    expect(posted.status).toBe(200);
    await expect(invocation).resolves.toEqual({ ok: true, content: 'awarded 3' });

    stream.close();
    await api('DELETE', `/api/app-tools/relays/${relayId}`, { token: appToken });
  }, 20_000);

  it('refuses a session-scoped token outright', async () => {
    const record = svc.context.tokenStore.issueSession({
      appId: 'session:app-tools-test',
      projectId: 'default',
      gezelId: 'ada',
      team: false,
    });
    // Two layers refuse this: the daemon-wide scope guard that keeps session
    // tokens off product routes, and this router's own check behind it. Either
    // answer is correct; what matters is that a gezel's own subprocess can
    // never register tools for itself.
    const res = await api('POST', '/api/app-tools/relays', { token: record.token, body: {} });
    expect(res.status).toBe(403);
  });

  it("hides another app's relay rather than admitting it exists", async () => {
    const relayId = await openRelay();
    try {
      const res = await api('PUT', `/api/app-tools/relays/${relayId}/tools`, {
        token: otherToken,
        body: { projectId: 'default', tools: [TOOL] },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'relay_not_found' });
    } finally {
      await api('DELETE', `/api/app-tools/relays/${relayId}`, { token: appToken });
    }
  });

  it('rejects an unknown project, a reserved name, and an oversized result', async () => {
    const relayId = await openRelay();
    const stream = await readEvents(relayId, (event) => event.type === 'ready');
    try {
      const missingProject = await api('PUT', `/api/app-tools/relays/${relayId}/tools`, {
        token: appToken,
        body: { projectId: 'no-such-project', tools: [TOOL] },
      });
      expect(missingProject.status).toBe(404);
      expect(await missingProject.json()).toMatchObject({ code: 'project_not_found' });

      const reserved = await api('PUT', `/api/app-tools/relays/${relayId}/tools`, {
        token: appToken,
        body: { projectId: 'default', tools: [{ ...TOOL, name: 'read_file' }] },
      });
      expect(reserved.status).toBe(409);
      expect(await reserved.json()).toMatchObject({ code: 'tool_name_reserved' });

      const tooBig = await api(
        'POST',
        `/api/app-tools/relays/${relayId}/calls/00000000-0000-0000-0000-000000000000/result`,
        { token: appToken, body: { ok: true, content: 'x'.repeat(80_001) } },
      );
      expect(tooBig.status).toBe(413);
      expect(await tooBig.json()).toMatchObject({ code: 'result_too_large' });

      const unknownCall = await api(
        'POST',
        `/api/app-tools/relays/${relayId}/calls/00000000-0000-0000-0000-000000000000/result`,
        { token: appToken, body: { ok: true, content: 'nobody is waiting' } },
      );
      expect(unknownCall.status).toBe(404);
      expect(await unknownCall.json()).toMatchObject({ code: 'unknown_call' });
    } finally {
      stream.close();
      await api('DELETE', `/api/app-tools/relays/${relayId}`, { token: appToken });
    }
  }, 20_000);
});
