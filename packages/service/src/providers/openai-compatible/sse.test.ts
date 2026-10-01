import { describe, expect, it } from 'vitest';
import { isSseComment, readSseEvents } from './sse.js';

describe('readSseEvents', () => {
  function streamOf(text: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode(text));
        ctrl.close();
      },
    });
  }

  it('parses two JSON frames separated by LF-LF', async () => {
    const events: unknown[] = [];
    for await (const ev of readSseEvents(streamOf('data: {"a":1}\n\ndata: {"a":2}\n\n'))) {
      events.push(ev);
    }
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('handles CRLF-CRLF separators', async () => {
    const events: unknown[] = [];
    for await (const ev of readSseEvents(streamOf('data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n'))) {
      events.push(ev);
    }
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('emits the literal "[DONE]" for the terminator frame', async () => {
    const events: unknown[] = [];
    for await (const ev of readSseEvents(streamOf('data: {"x":1}\n\ndata: [DONE]\n\n'))) {
      events.push(ev);
    }
    expect(events).toEqual([{ x: 1 }, '[DONE]']);
  });

  it('ignores non-data lines (`event:`, `:keepalive`, etc.)', async () => {
    const events: unknown[] = [];
    const text = ': keepalive\n\nevent: ping\ndata: {"a":1}\n\n';
    for await (const ev of readSseEvents(streamOf(text))) {
      events.push(ev);
    }
    expect(events).toEqual([{ a: 1 }]);
  });

  it('tolerates malformed data chunks without throwing', async () => {
    const events: unknown[] = [];
    const text = 'data: not-json\n\ndata: {"a":2}\n\n';
    for await (const ev of readSseEvents(streamOf(text))) {
      events.push(ev);
    }
    expect(events).toEqual([{ a: 2 }]);
  });

  it('surfaces comment lines as SseComment objects when opted in', async () => {
    // ds4-server pings `: prefill` every ~5s during prompt processing —
    // the only wire signal for minutes on a 284B SSD-streamed model.
    const events: unknown[] = [];
    const text = ': prefill\n\n: prefill\n\ndata: {"a":1}\n\n';
    for await (const ev of readSseEvents(streamOf(text), { comments: true })) {
      events.push(ev);
    }
    expect(events).toEqual([{ sseComment: 'prefill' }, { sseComment: 'prefill' }, { a: 1 }]);
    expect(isSseComment(events[0])).toBe(true);
    expect(isSseComment(events[2])).toBe(false);
  });

  it('still drops comment lines by default', async () => {
    const events: unknown[] = [];
    for await (const ev of readSseEvents(streamOf(': prefill\n\ndata: {"a":1}\n\n'))) {
      events.push(ev);
    }
    expect(events).toEqual([{ a: 1 }]);
  });
});
