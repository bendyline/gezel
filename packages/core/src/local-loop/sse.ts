/**
 * Shared SSE decoder for OpenAI Chat Completions-compatible servers.
 *
 * Every local HTTP inference server Gezel speaks to (llama-server,
 * mlx_lm.server, ds4-server, and any future OpenAI-shaped runtime)
 * emits the same SSE shape: `data: <json>\n\n` pairs terminated by
 * `data: [DONE]\n\n`. This module owns the parsing so each provider
 * only deals in already-decoded JSON chunks (or the literal `'[DONE]'`
 * sentinel).
 *
 * Tolerates:
 *   - `\n\n` and `\r\n\r\n` event separators (both are legal SSE).
 *   - Non-`data:` lines (`event:`, `:keepalive`, etc.) — skipped
 *     silently by default.
 *   - Malformed JSON on a single `data:` line — skipped, not raised, so
 *     a hiccup from the server doesn't abort the whole turn.
 *
 * Comment lines (`: prefill`) are dropped by default, but a caller can
 * opt in via `{ comments: true }` to receive them as {@link SseComment}
 * objects. ds4-server pings `: prefill` every ~5s while prompt
 * processing runs — for a 284B SSD-streamed model that's the ONLY wire
 * signal for minutes at a time, so dropping it turns a healthy prefill
 * into apparent silence (stall banners, idle watchdogs).
 */

/** A `: comment` line surfaced from the stream when opted in. */
export interface SseComment {
  sseComment: string;
}

export function isSseComment(event: unknown): event is SseComment {
  return (
    typeof event === 'object' &&
    event !== null &&
    typeof (event as SseComment).sseComment === 'string'
  );
}

export async function* readSseEvents(
  body: ReadableStreamLike<Uint8Array>,
  opts?: {
    /** Yield `: comment` lines as {@link SseComment} objects. Default false. */
    comments?: boolean;
  },
): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) buffer += decoder.decode(value, { stream: true });
    // SSE events are separated by a blank line.
    let sepIdx: number;
    while (true) {
      const lfIdx = buffer.indexOf('\n\n');
      const crlfIdx = buffer.indexOf('\r\n\r\n');
      if (lfIdx === -1 && crlfIdx === -1) break;
      sepIdx = lfIdx === -1 ? crlfIdx : crlfIdx === -1 ? lfIdx : Math.min(lfIdx, crlfIdx);
      const sepLen = sepIdx === crlfIdx ? 4 : 2;
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + sepLen);
      // One event is one or more lines; each `data:` line carries a
      // JSON payload (or the literal `[DONE]`). Non-data lines (e.g.
      // `event:`) are ignored in Chat Completions; `:` comment lines
      // surface only when the caller opted in.
      for (const line of rawEvent.split(/\r?\n/)) {
        if (!line.startsWith('data:')) {
          if (opts?.comments && line.startsWith(':')) {
            yield { sseComment: line.slice(1).trim() } satisfies SseComment;
          }
          continue;
        }
        const payload = line.slice(5).trimStart();
        if (payload === '[DONE]') {
          yield '[DONE]';
          continue;
        }
        if (payload.length === 0) continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // Malformed chunk; skip and keep reading. Engines are
          // reliable enough that this path should rarely fire, but we
          // tolerate it rather than hanging the whole turn.
        }
      }
    }
  }
}

// Local DOM-free type so we don't need the `dom` lib.
interface ReadableStreamLike<T> {
  getReader(): {
    read(): Promise<{ value: T | undefined; done: boolean }>;
  };
}
