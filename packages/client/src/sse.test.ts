import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  SsePayloadError,
  SsePrematureEofError,
  type SseStreamOptions,
  SseStreamStaleError,
  consumeSseJson,
} from './sse.js';

// Reach the internal generator via the same import path consumers
// use — the named factory stamps the schema in. The keepalive
// behavior is generic across factories, so testing against the
// envelope factory covers the same code path as the bare one.
import { streamProjectChatEvents } from './sse.js';

/**
 * Build a fake `Response` whose body never emits — simulates a
 * silently-dead socket. The stream's `start` controller is held
 * open; we never close, never enqueue. Without keepalive detection
 * the consumer would hang forever.
 */
function silentResponseFetch(): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueue, never close */
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

/** Build a fetch that streams a single envelope then hangs. */
function oneEventThenSilenceFetch(payload: object): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        // Then go silent — no more bytes, no close.
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

describe('sseStream keepalive detection', () => {
  it('throws SseStreamStaleError when the server sends nothing within keepaliveTimeoutMs', async () => {
    const opts: SseStreamOptions = {
      url: 'http://test/stream',
      fetch: silentResponseFetch(),
      keepaliveTimeoutMs: 50,
    };
    const it = streamProjectChatEvents(opts);
    await expect(it.next()).rejects.toBeInstanceOf(SseStreamStaleError);
  });

  it('does NOT trip keepalive when set to 0 (disabled)', async () => {
    // Race: start the iterator, wait 100ms (longer than the 50ms
    // we'd use otherwise), assert nothing rejected. We can't
    // actually wait forever, so this asserts behavior up to the
    // wait window — proves the code path that fires the timeout
    // is gated by the > 0 check.
    const opts: SseStreamOptions = {
      url: 'http://test/stream',
      fetch: silentResponseFetch(),
      keepaliveTimeoutMs: 0,
    };
    const iter = streamProjectChatEvents(opts);
    const next = iter.next();
    const settled = await Promise.race([
      next.then(() => 'resolved'),
      new Promise<string>((r) => setTimeout(() => r('still-pending'), 100)),
    ]);
    expect(settled).toBe('still-pending');
    // Don't leak the iterator.
    void iter.return?.(undefined as never);
  });

  it('keepalive does NOT fire while data is flowing', async () => {
    // The real fetch enqueues one valid envelope, then goes silent.
    // The stream should yield that event before the keepalive
    // timer (set at 100ms) fires. Then the NEXT read trips the
    // timeout because no more bytes arrive.
    const opts: SseStreamOptions = {
      url: 'http://test/stream',
      fetch: oneEventThenSilenceFetch({
        sessionId: 's1',
        gezelId: 'ada',
        projectId: 'eliza',
        event: { type: 'delta', content: 'hi' },
      }),
      keepaliveTimeoutMs: 100,
    };
    const iter = streamProjectChatEvents(opts);
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value?.event.type).toBe('delta');
    // The next read times out within keepaliveTimeoutMs.
    await expect(iter.next()).rejects.toBeInstanceOf(SseStreamStaleError);
  });
});

describe('finite SSE operations', () => {
  const schema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('progress'), value: z.number() }),
    z.object({ type: z.literal('done') }),
  ]);

  function responseFetch(body: string): typeof fetch {
    return (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  }

  it('accepts CRLF frames and a terminal event', async () => {
    const seen: string[] = [];
    await consumeSseJson({
      url: 'http://test/op',
      fetch: responseFetch(
        'data: {"type":"progress","value":1}\r\n\r\ndata: {"type":"done"}\r\n\r\n',
      ),
      schema,
      onEvent: (event) => seen.push(event.type),
      isTerminal: (event) => event.type === 'done',
    });
    expect(seen).toEqual(['progress', 'done']);
  });

  it('rejects EOF before a terminal frame', async () => {
    await expect(
      consumeSseJson({
        url: 'http://test/op',
        fetch: responseFetch('data: {"type":"progress","value":1}\n\n'),
        schema,
        onEvent: () => {},
        isTerminal: (event) => event.type === 'done',
      }),
    ).rejects.toBeInstanceOf(SsePrematureEofError);
  });

  it('rejects malformed or schema-invalid operation frames', async () => {
    await expect(
      consumeSseJson({
        url: 'http://test/op',
        fetch: responseFetch('data: {"type":"progress","value":"wrong"}\n\n'),
        schema,
        onEvent: () => {},
        isTerminal: (event) => event.type === 'done',
      }),
    ).rejects.toBeInstanceOf(SsePayloadError);
  });
});
