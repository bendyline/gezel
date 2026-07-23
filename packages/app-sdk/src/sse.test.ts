import { describe, expect, it } from 'vitest';
import { readSseDataChunks } from './sse.js';

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(text));
      c.close();
    },
  });
}

/** Chunk a string into N-byte pieces — exercises partial-frame buffering. */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('readSseDataChunks', () => {
  it('parses a single data frame', async () => {
    const stream = streamFromText('data: hello\n\n');
    expect(await collect(readSseDataChunks(stream))).toEqual(['hello']);
  });

  it('parses multiple frames', async () => {
    const stream = streamFromText('data: a\n\ndata: b\n\ndata: c\n\n');
    expect(await collect(readSseDataChunks(stream))).toEqual(['a', 'b', 'c']);
  });

  it('joins multi-line data fields with a single newline', async () => {
    const stream = streamFromText('data: line1\ndata: line2\n\n');
    expect(await collect(readSseDataChunks(stream))).toEqual(['line1\nline2']);
  });

  it('ignores event: and id: lines', async () => {
    const stream = streamFromText('event: ping\nid: 42\ndata: payload\n\n');
    expect(await collect(readSseDataChunks(stream))).toEqual(['payload']);
  });

  it('ignores keepalive frames (event: ping with empty data)', async () => {
    // `event: ping\ndata: \n\n` is what the server emits as keepalive.
    // The data is empty but the parser still yields the empty string —
    // higher layers (chat stream, ensure-events) filter falsy chunks.
    const stream = streamFromText('event: ping\ndata: \n\ndata: real\n\n');
    expect(await collect(readSseDataChunks(stream))).toEqual(['', 'real']);
  });

  it('handles \\r\\n line endings', async () => {
    const stream = streamFromText('data: x\r\n\r\ndata: y\r\n\r\n');
    expect(await collect(readSseDataChunks(stream))).toEqual(['x', 'y']);
  });

  it('buffers across chunk boundaries inside a frame', async () => {
    const stream = streamFromChunks(['data: par', 'tial\n', '\ndata: ', 'rest\n\n']);
    expect(await collect(readSseDataChunks(stream))).toEqual(['partial', 'rest']);
  });

  it('yields a final frame even without trailing blank line', async () => {
    const stream = streamFromText('data: alone');
    expect(await collect(readSseDataChunks(stream))).toEqual(['alone']);
  });

  it('yields nothing for an empty stream', async () => {
    const stream = streamFromText('');
    expect(await collect(readSseDataChunks(stream))).toEqual([]);
  });

  it('yields the [DONE] sentinel verbatim (caller filters)', async () => {
    const stream = streamFromText('data: {"x":1}\n\ndata: [DONE]\n\n');
    expect(await collect(readSseDataChunks(stream))).toEqual(['{"x":1}', '[DONE]']);
  });
});
