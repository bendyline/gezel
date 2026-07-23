/**
 * Minimal SSE chunk reader over a fetch `Response.body`. Yields parsed
 * `data:` payloads as strings; ignores `event:`, `id:`, comments, and
 * keepalive pings. The OpenAI sentinel `data: [DONE]` is yielded so
 * callers can detect end-of-stream (the stream itself also closes,
 * but the sentinel arrives one chunk earlier in typical OpenAI
 * implementations).
 *
 * Designed to work over both undici (Node) and the browser fetch
 * since both expose `body` as a ReadableStream<Uint8Array>.
 */
export async function* readSseDataChunks(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line (`\n\n` or
      // `\r\n\r\n`). Split, keep the trailing partial frame in the
      // buffer.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const lines = frame.split(/\r?\n/);
        // Collect every `data:` line and join with `\n` per SSE spec.
        const dataParts: string[] = [];
        for (const line of lines) {
          if (line.startsWith('data:')) {
            dataParts.push(line.slice(5).replace(/^ /, ''));
          }
        }
        if (dataParts.length > 0) {
          yield dataParts.join('\n');
        }
      }
    }
    // Flush any final frame that didn't end with a blank line.
    if (buffer.trim()) {
      const lines = buffer.split(/\r?\n/);
      const dataParts: string[] = [];
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataParts.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (dataParts.length > 0) yield dataParts.join('\n');
    }
  } finally {
    reader.releaseLock();
  }
}
