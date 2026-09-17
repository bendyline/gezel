import { describe, expect, it, vi } from 'vitest';
import { registerAppTools } from './app-tools.js';

const BASE = 'https://127.0.0.1:4321';

/** One SSE frame per event, in the daemon's wire shape. */
function sseBody(events: unknown[], hold = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      if (!hold) controller.close();
    },
  });
}

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * A daemon stub: opens one relay, accepts the tool registration, delivers the
 * scripted events, and records everything the SDK sent back.
 */
function stubDaemon(opts: { events?: unknown[]; relayStatus?: number[] } = {}) {
  const recorded: Recorded[] = [];
  const relayStatuses = [...(opts.relayStatus ?? [])];
  let opened = 0;
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).slice(BASE.length);
    const method = init?.method ?? 'GET';
    recorded.push({
      method,
      path,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });

    if (path === '/api/app-tools/relays' && method === 'POST') {
      opened += 1;
      return new Response(JSON.stringify({ relayId: `relay-${opened}` }), { status: 201 });
    }
    if (path.endsWith('/tools') && method === 'PUT') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (path.endsWith('/events')) {
      const status = relayStatuses.shift();
      if (status && status !== 200) return new Response('gone', { status });
      return new Response(sseBody(opts.events ?? [{ type: 'ready' }], true), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, recorded, openedCount: () => opened };
}

const CONNECTION = { baseUrl: BASE, token: 'app-token' };

const TOOL = {
  name: 'add_travel_points',
  description: 'Award travel points.',
  inputSchema: { type: 'object', properties: { points: { type: 'number' } } },
};

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('registerAppTools', () => {
  it('registers the tools and reports connected', async () => {
    const daemon = stubDaemon();
    const onStatus = vi.fn();
    const registration = await registerAppTools(
      { ...CONNECTION, fetch: daemon.fetchImpl },
      { projectId: 'trips', tools: [{ ...TOOL, handler: async () => 'ok' }], onStatus },
    );
    try {
      const put = daemon.recorded.find((entry) => entry.method === 'PUT');
      expect(put?.path).toBe('/api/app-tools/relays/relay-1/tools');
      expect(put?.body).toMatchObject({
        projectId: 'trips',
        tools: [{ name: 'add_travel_points', description: 'Award travel points.' }],
      });
      // The handler is the app's; it must never be serialized to the daemon.
      expect(JSON.stringify(put?.body)).not.toContain('handler');
      expect(onStatus).toHaveBeenCalledWith('connected');
    } finally {
      await registration.close();
    }
  });

  it('runs the handler for a delivered call and posts its answer', async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => `awarded ${args.points}`);
    const daemon = stubDaemon({
      events: [
        { type: 'ready' },
        {
          type: 'tool_call',
          callId: 'call-1',
          tool: 'add_travel_points',
          arguments: { points: 5 },
          sessionId: 's1',
          gezelId: 'gids',
          projectId: 'trips',
          timeoutMs: 30_000,
          at: new Date().toISOString(),
        },
      ],
    });
    const registration = await registerAppTools(
      { ...CONNECTION, fetch: daemon.fetchImpl },
      { projectId: 'trips', tools: [{ ...TOOL, handler }] },
    );
    await settle();
    try {
      expect(handler).toHaveBeenCalledWith(
        { points: 5 },
        expect.objectContaining({ callId: 'call-1', sessionId: 's1', gezelId: 'gids' }),
      );
      const posted = daemon.recorded.find((entry) => entry.path.endsWith('/calls/call-1/result'));
      expect(posted?.body).toEqual({ ok: true, content: 'awarded 5' });
    } finally {
      await registration.close();
    }
  });

  it('reports a throwing handler as a failed tool call, not a crash', async () => {
    const onError = vi.fn();
    const daemon = stubDaemon({
      events: [
        { type: 'ready' },
        {
          type: 'tool_call',
          callId: 'call-2',
          tool: 'add_travel_points',
          arguments: {},
          sessionId: 's1',
          gezelId: 'gids',
          projectId: 'trips',
          timeoutMs: 30_000,
          at: new Date().toISOString(),
        },
      ],
    });
    const registration = await registerAppTools(
      { ...CONNECTION, fetch: daemon.fetchImpl },
      {
        projectId: 'trips',
        tools: [
          {
            ...TOOL,
            handler: async () => {
              throw new Error('the traveller has no account');
            },
          },
        ],
        onError,
      },
    );
    await settle();
    try {
      const posted = daemon.recorded.find((entry) => entry.path.endsWith('/calls/call-2/result'));
      expect(posted?.body).toEqual({ ok: false, error: 'the traveller has no account' });
      expect(onError).toHaveBeenCalled();
    } finally {
      await registration.close();
    }
  });

  it('opens a fresh relay when the old one is gone', async () => {
    const daemon = stubDaemon({ relayStatus: [404, 200] });
    const onStatus = vi.fn();
    const registration = await registerAppTools(
      { ...CONNECTION, fetch: daemon.fetchImpl },
      { projectId: 'trips', tools: [{ ...TOOL, handler: async () => 'ok' }], onStatus },
    );
    await settle();
    try {
      // The registration is re-published against the new relay; an app does
      // not have to notice that the daemon forgot it.
      expect(daemon.openedCount()).toBe(2);
      expect(daemon.recorded.filter((entry) => entry.method === 'PUT')).toHaveLength(2);
    } finally {
      await registration.close();
    }
  });

  it('withdraws the tools on close', async () => {
    const daemon = stubDaemon();
    const registration = await registerAppTools(
      { ...CONNECTION, fetch: daemon.fetchImpl },
      { projectId: 'trips', tools: [{ ...TOOL, handler: async () => 'ok' }] },
    );
    await registration.close();
    expect(
      daemon.recorded.some(
        (entry) => entry.method === 'DELETE' && entry.path === '/api/app-tools/relays/relay-1',
      ),
    ).toBe(true);
  });
});
