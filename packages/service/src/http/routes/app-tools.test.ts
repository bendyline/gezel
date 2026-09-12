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
  // A full service boot resolves a large slice of its module graph through
  // dynamic imports, so the cost lands inside this hook. Alone that is under
  // a second; under full-suite pressure it has overrun 30 s (the sibling
  // service-boot suites carry the same 60 s budget for the same reason).
}, 60_000);

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

interface RelayStream {
  /** Every event seen so far, in arrival order. */
  events: AppToolRelayEvent[];
  /** The first event matching `match`, past arrivals included. */
  waitFor: (match: (event: AppToolRelayEvent) => boolean) => Promise<AppToolRelayEvent>;
  close: () => void;
}

/**
 * Attach to a relay's event stream and stay attached for the rest of the test,
 * accumulating events in the background.
 *
 * Staying attached is the point. `invoke` deliberately fails fast against a
 * relay with no sink, so a test that detaches and re-attaches has to prove the
 * new stream landed before it drives a call — and a fixed sleep is not that
 * proof under full-suite load. The `ready` frame is: the registry emits it
 * immediately after it installs the sink. So callers await `ready` once and
 * then keep the same stream.
 */
async function openStream(relayId: string, token = appToken): Promise<RelayStream> {
  const controller = new AbortController();
  const res = await httpFetch(`${baseUrl}/api/app-tools/relays/${relayId}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no event stream body');

  const events: AppToolRelayEvent[] = [];
  const waiters: {
    match: (event: AppToolRelayEvent) => boolean;
    resolve: (event: AppToolRelayEvent) => void;
  }[] = [];

  const deliver = (event: AppToolRelayEvent): void => {
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (!waiter?.match(event)) continue;
      waiters.splice(i, 1);
      waiter.resolve(event);
    }
  };

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
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
          if (data) deliver(JSON.parse(data) as AppToolRelayEvent);
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // `close()` aborts mid-read. A stream that ends is not a test failure;
      // an event that never arrives fails as a timeout on whoever awaits it.
    }
  })();

  return {
    events,
    waitFor: (match) => {
      const seen = events.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise<AppToolRelayEvent>((resolve) => {
        waiters.push({ match, resolve });
      });
    },
    close: () => controller.abort(),
  };
}

describe('/api/app-tools', () => {
  it('opens a relay, announces readiness, and registers tools for a project', async () => {
    const relayId = await openRelay();
    const stream = await openStream(relayId);
    try {
      expect(await stream.waitFor((event) => event.type === 'ready')).toMatchObject({
        type: 'ready',
        relayId,
      });

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
    const stream = await openStream(relayId);
    try {
      // `ready` proves the sink is installed, so the call below cannot be
      // emitted into a relay the stream has not attached to yet.
      await stream.waitFor((event) => event.type === 'ready');
      await api('PUT', `/api/app-tools/relays/${relayId}/tools`, {
        token: appToken,
        body: { projectId: 'default', tools: [TOOL] },
      });

      // Drive a call through the registry the way a session would.
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

      const call = await stream.waitFor((event) => event.type === 'tool_call');
      if (call.type !== 'tool_call') throw new Error('no tool_call received');
      expect(call).toMatchObject({ tool: 'add_travel_points', arguments: { points: 3 } });

      const posted = await api(
        'POST',
        `/api/app-tools/relays/${relayId}/calls/${call.callId}/result`,
        { token: appToken, body: { ok: true, content: 'awarded 3' } },
      );
      expect(posted.status).toBe(200);
      await expect(invocation).resolves.toEqual({ ok: true, content: 'awarded 3' });
    } finally {
      stream.close();
      await api('DELETE', `/api/app-tools/relays/${relayId}`, { token: appToken });
    }
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
    const stream = await openStream(relayId);
    try {
      await stream.waitFor((event) => event.type === 'ready');
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
