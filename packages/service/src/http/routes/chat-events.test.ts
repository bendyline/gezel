import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let gezelId: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  const home = await mkdtemp(join(tmpdir(), 'gezel-chat-events-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  // Seed one gezel for the SSE tests to share.
  const res = await httpFetch(`${baseUrl}/api/gezels`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'EventsBot' }),
  });
  const created = (await res.json()) as { id: string };
  gezelId = created.id;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(svc.context.home, { recursive: true, force: true }).catch(() => {});
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

/**
 * Open an SSE stream and read frames until either `until(events)` returns
 * true or the deadline elapses. Returns whatever was collected so the
 * caller can assert on it. The stream is aborted via `controller`.
 */
async function readSSEUntil<T>(
  url: string,
  controller: AbortController,
  parse: (raw: unknown) => T,
  until: (events: T[]) => boolean,
  deadlineMs = 10_000,
): Promise<{ events: T[]; status: number; contentType: string | null }> {
  const res = await httpFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const status = res.status;
  const contentType = res.headers.get('content-type');
  if (!res.ok || !res.body) return { events: [], status, contentType };

  const events: T[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + deadlineMs;
  try {
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
          events.push(parse(JSON.parse(payload)));
        } catch {
          /* skip keepalives / malformed */
        }
      }
      if (until(events)) break;
    }
  } finally {
    controller.abort();
  }
  return { events, status, contentType };
}

describe('GET /events/chat — single-session stream', () => {
  it('responds with text/event-stream and streams the bare ChatEvent payload', async () => {
    const created = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };
    const controller = new AbortController();
    const sendPromise = api('POST', `/api/sessions/${created.id}/send`, {
      message: 'sse smoke test',
    });

    type Ev = { type: string; content?: string };
    const { events, contentType } = await readSSEUntil<Ev>(
      `${baseUrl}/events/chat?session=${created.id}`,
      controller,
      (raw) => raw as Ev,
      (es) => es.some((e) => e.type === 'done'),
    );
    await sendPromise;

    // SSE content-type contract — UI's EventSource refuses anything else.
    expect(contentType ?? '').toMatch(/text\/event-stream/);

    // The bare-ChatEvent shape: each event has a `type` discriminator,
    // not the project/all-stream `envelope { sessionId, event }` shape.
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(typeof e.type).toBe('string');
    }
    // Order matters: at least one delta should arrive before complete,
    // and complete before done.
    const types = events.map((e) => e.type);
    const firstDelta = types.indexOf('delta');
    const firstComplete = types.indexOf('complete');
    const firstDone = types.indexOf('done');
    expect(firstDelta).toBeGreaterThanOrEqual(0);
    expect(firstComplete).toBeGreaterThan(firstDelta);
    expect(firstDone).toBeGreaterThan(firstComplete);
  }, 15_000);

  it('resolves a (gezel, project) pair to the most-recent active session when ?session= is omitted', async () => {
    // Drive a send through the legacy gezel-scoped endpoint so a session
    // exists, then connect with ?gezel= only and verify a stream opens.
    await api('POST', `/api/gezels/${gezelId}/chat/send`, { message: 'pair-resolve seed' });

    const controller = new AbortController();
    type Ev = { type: string };
    // We don't need a full turn to flow — just confirm the stream opens
    // and stays open long enough for at least one frame (the keepalive
    // ping fires every 1s in the route).
    const { status, contentType } = await readSSEUntil<Ev>(
      `${baseUrl}/events/chat?gezel=${gezelId}`,
      controller,
      (raw) => raw as Ev,
      // Stop on the first parsed frame OR after the keepalive window.
      () => false,
      1500,
    );
    expect(status).toBe(200);
    expect(contentType ?? '').toMatch(/text\/event-stream/);
  }, 10_000);

  it('returns 400 when neither session nor gezel is provided', async () => {
    const res = await api('GET', '/events/chat');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/session|gezel/);
  });

  it('returns 404 when the gezel has no active session', async () => {
    // Fresh gezel, no sessions yet → no active to resolve to.
    const created = (await (
      await api('POST', '/api/gezels', { name: 'NoSessionsBot' })
    ).json()) as { id: string };
    const res = await api('GET', `/events/chat?gezel=${created.id}`);
    expect(res.status).toBe(404);
  });

  it('does not resolve an ordinary gezel stream to a task session', async () => {
    const created = (await (
      await api('POST', '/api/gezels', { name: 'TaskSessionOnlyBot' })
    ).json()) as { id: string };
    await svc.context.chat.createSession({
      gezelId: created.id,
      projectId: 'default',
      taskRef: 'default/99',
      stepId: 'night-shift',
      nightShift: true,
    });

    const res = await api('GET', `/events/chat?gezel=${created.id}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /events/chat/project — project envelope stream', () => {
  it('streams ChatEventEnvelope (sessionId + event) for sends in the project', async () => {
    const session = (await (
      await api('POST', '/api/sessions', { gezelId, projectId: 'default' })
    ).json()) as { id: string };

    const controller = new AbortController();
    const sendPromise = api('POST', `/api/sessions/${session.id}/send`, {
      message: 'envelope test',
    });

    type Envelope = { sessionId: string; event: { type: string } };
    const { events, status, contentType } = await readSSEUntil<Envelope>(
      `${baseUrl}/events/chat/project?project=default`,
      controller,
      (raw) => raw as Envelope,
      (es) => es.some((e) => e.event.type === 'done' && e.sessionId === session.id),
    );
    await sendPromise;

    expect(status).toBe(200);
    expect(contentType ?? '').toMatch(/text\/event-stream/);

    // Envelope shape — sessionId is the key contract that lets the
    // interleaved project timeline disambiguate which session a frame
    // belongs to. If the route ever drops it, every tab in the project
    // timeline silently merges into one chat.
    const ours = events.filter((e) => e.sessionId === session.id);
    expect(ours.length).toBeGreaterThan(0);
    for (const e of ours) {
      expect(typeof e.sessionId).toBe('string');
      expect(typeof e.event?.type).toBe('string');
    }
  }, 15_000);

  it('returns 400 without ?project=', async () => {
    const res = await api('GET', '/events/chat/project');
    expect(res.status).toBe(400);
  });
});

describe('GET /events/chat/all — global envelope stream', () => {
  it('opens with text/event-stream and emits envelopes for any session', async () => {
    const session = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };

    const controller = new AbortController();
    const sendPromise = api('POST', `/api/sessions/${session.id}/send`, {
      message: 'global stream',
    });

    type Envelope = { sessionId: string; event: { type: string } };
    const { events, status, contentType } = await readSSEUntil<Envelope>(
      `${baseUrl}/events/chat/all`,
      controller,
      (raw) => raw as Envelope,
      (es) => es.some((e) => e.sessionId === session.id && e.event.type === 'done'),
    );
    await sendPromise;

    expect(status).toBe(200);
    expect(contentType ?? '').toMatch(/text\/event-stream/);
    expect(events.some((e) => e.sessionId === session.id)).toBe(true);
  }, 15_000);
});

// ── SSE protocol contract ────────────────────────────────────────────
//
// The tests above parse `data:` payloads and discard everything else.
// These contract tests introspect the *frame shape* — `event:` lines,
// `id:` lines, keepalive cadence, the close-on-done lifecycle. The UI's
// streaming consumer relies on this exact wire format; a silent
// regression here surfaces as "messages don't stream" with no unit
// failure, only e2e flakiness or a user bug report.

interface SSEFrame {
  /** Named event from the `event:` line. Default-event frames have no event. */
  event?: string;
  /** Concatenated `data:` lines (one frame may span multiple data lines). */
  data: string;
  /** `id:` line — currently never set by the route (no Last-Event-ID support). */
  id?: string;
  /** `retry:` line — currently never set by the route. */
  retry?: number;
}

/**
 * Read the SSE response body until `until(frames)` returns true or the
 * deadline elapses. Returns the *raw* frames (not just decoded JSON
 * payloads) so callers can assert on the wire format itself.
 *
 * Frame parsing follows the WHATWG SSE spec: lines accumulate into
 * the current frame, a blank line dispatches the frame, and `event:`/
 * `data:`/`id:`/`retry:` are the four recognized field names.
 */
async function readSSEFramesUntil(
  url: string,
  controller: AbortController,
  until: (frames: SSEFrame[]) => boolean,
  deadlineMs = 4_000,
  init?: RequestInit,
): Promise<{ frames: SSEFrame[]; status: number; contentType: string | null }> {
  const res = await httpFetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    signal: controller.signal,
  });
  const status = res.status;
  const contentType = res.headers.get('content-type');
  if (!res.ok || !res.body) return { frames: [], status, contentType };

  const frames: SSEFrame[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let current: SSEFrame = { data: '' };
  const dispatch = () => {
    // Per the SSE spec, a frame with empty data is dispatched only when
    // it carries a non-data field (event/id/retry). The route's
    // keepalive frames carry `event: ping, data: ''` so they pass.
    const hasContent = current.data !== '' || current.event || current.id || current.retry;
    if (hasContent) frames.push(current);
    current = { data: '' };
  };
  const handleLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    // Comment lines start with `:` per the SSE spec — ignore.
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        current.event = value;
        break;
      case 'data':
        current.data = current.data === '' ? value : `${current.data}\n${value}`;
        break;
      case 'id':
        current.id = value;
        break;
      case 'retry': {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) current.retry = n;
        break;
      }
    }
  };

  const deadline = Date.now() + deadlineMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF / CR → LF before splitting (SSE allows all three).
      buffer = buffer.replace(/\r\n?/g, '\n');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
      if (until(frames)) break;
    }
  } finally {
    controller.abort();
  }
  return { frames, status, contentType };
}

describe('SSE protocol contract', () => {
  it('data frames carry no `event:` field and the payload is JSON-parseable', async () => {
    const session = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };
    const controller = new AbortController();
    const sendPromise = api('POST', `/api/sessions/${session.id}/send`, {
      message: 'frame shape',
    });

    const { frames } = await readSSEFramesUntil(
      `${baseUrl}/events/chat?session=${session.id}`,
      controller,
      (fs) => {
        // Stop after we've seen at least one default-event data frame
        // that decodes to a `done` event.
        return fs.some((f) => {
          if (f.event !== undefined) return false;
          try {
            const ev = JSON.parse(f.data) as { type?: string };
            return ev.type === 'done';
          } catch {
            return false;
          }
        });
      },
      10_000,
    );
    await sendPromise;

    const dataFrames = frames.filter((f) => f.event === undefined);
    expect(dataFrames.length).toBeGreaterThan(0);
    // Every default-event data frame is JSON and shaped as `{ type: ... }`.
    for (const f of dataFrames) {
      const parsed = JSON.parse(f.data) as { type: string };
      expect(typeof parsed.type).toBe('string');
    }
    // Contract today: no `id:` lines (Last-Event-ID isn't implemented).
    // If this ever changes, the test fails and the contract documentation
    // (and any UI consumer's resume logic) needs to be updated.
    expect(frames.every((f) => f.id === undefined)).toBe(true);
  }, 15_000);

  it('emits `event: ping` keepalive frames roughly every second when idle', async () => {
    // Subscribe to a fresh gezel that has no traffic — only keepalives
    // should flow. The route writes a ping every 1s; a 2.5s window
    // should give us at least one and usually two.
    const created = (await (await api('POST', '/api/gezels', { name: 'KeepaliveBot' })).json()) as {
      id: string;
    };
    // Open a session so the SSE handler stays open (no 404).
    const session = (await (
      await api('POST', '/api/sessions', { gezelId: created.id })
    ).json()) as { id: string };

    const controller = new AbortController();
    const { frames, contentType } = await readSSEFramesUntil(
      `${baseUrl}/events/chat?session=${session.id}`,
      controller,
      // Stop as soon as we see a ping; otherwise let the deadline cap us.
      (fs) => fs.some((f) => f.event === 'ping'),
      2_500,
    );

    expect(contentType ?? '').toMatch(/text\/event-stream/);
    const pings = frames.filter((f) => f.event === 'ping');
    expect(pings.length).toBeGreaterThan(0);
    // Keepalive frames carry empty data — that's the contract that lets
    // the UI recognize them as heartbeats vs real events without parsing.
    for (const p of pings) {
      expect(p.data).toBe('');
    }
  }, 6_000);

  it('accepts a Last-Event-ID request header (no crash) and produces a fresh stream', async () => {
    // The route doesn't honor Last-Event-ID today (it doesn't set `id:`
    // on any frame, so there's nothing meaningful to resume from). This
    // test pins the current behavior: a client that sends the header
    // gets a normal 200 + text/event-stream + a *fresh* stream from
    // wherever the subscriber starts. If real resume support is added,
    // this test fails and the contract gets re-documented.
    const session = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };
    const controller = new AbortController();
    const { status, contentType, frames } = await readSSEFramesUntil(
      `${baseUrl}/events/chat?session=${session.id}`,
      controller,
      // Stop on the first ping or any frame at all.
      (fs) => fs.length > 0,
      2_500,
      { headers: { 'Last-Event-ID': '12345' } },
    );

    expect(status).toBe(200);
    expect(contentType ?? '').toMatch(/text\/event-stream/);
    // No `id:` lines today regardless of what the client requested.
    expect(frames.every((f) => f.id === undefined)).toBe(true);
  }, 6_000);

  it('close-on-done lifecycle: the server ends the finite stream and allows a fresh connect', async () => {
    // A session stream represents one finite turn. The server must end the
    // response after writing `done`; relying on renderer cancellation left
    // enough retiring HTTP connections to hit Chromium's per-origin cap.
    const session = (await (await api('POST', '/api/sessions', { gezelId })).json()) as {
      id: string;
    };

    const controller = new AbortController();
    const response = await httpFetch(`${baseUrl}/events/chat?session=${session.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeTruthy();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let reachedEof = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error('session SSE did not close after done')),
        10_000,
      );
    });

    try {
      const sendPromise = api('POST', `/api/sessions/${session.id}/send`, {
        message: 'lifecycle',
      });
      while (true) {
        const { value, done } = await Promise.race([reader.read(), deadline]);
        if (done) {
          reachedEof = true;
          break;
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      await sendPromise;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      controller.abort();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }

    expect(raw).toContain('"type":"done"');
    expect(reachedEof).toBe(true);

    // Phase 2: a second connect cycle must work end-to-end. If the
    // first close leaked a subscriber or hung the keepalive loop,
    // the second connect would either 5xx or never produce a frame
    // before the deadline.
    const controller2 = new AbortController();
    const { status: status2, frames: frames2 } = await readSSEFramesUntil(
      `${baseUrl}/events/chat?session=${session.id}`,
      controller2,
      (fs) => fs.length > 0,
      2_500,
    );
    expect(status2).toBe(200);
    // We didn't drive a send on this connect, so the only frames we
    // expect within the window are pings (or none, if scheduling is
    // unlucky). What we *don't* tolerate is a non-200 from a leaked
    // subscriber.
    expect(frames2.every((f) => f.event === 'ping' || f.event === undefined)).toBe(true);
  }, 20_000);
});
