/**
 * Cheap bounded-buffer for subprocess output. Grows as bytes come in,
 * then slides the window once we pass `maxBytes` so we always keep
 * the most-recent slice. `toString()` returns the slice + a
 * `truncated` flag so callers can surface "…" prefixes to the user.
 *
 * Why not just cap at write-time? Because we want `onLine` streams to
 * keep delivering full lines to subscribers (tool-call UIs) while the
 * final returned `stdout`/`stderr` stays bounded for serialization.
 */
export class OutputRingBuffer {
  private buf = '';
  private truncated = false;
  constructor(private readonly maxBytes: number) {}

  append(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.maxBytes) {
      this.buf = this.buf.slice(-this.maxBytes);
      this.truncated = true;
    }
  }

  value(): { text: string; truncated: boolean } {
    return { text: this.buf, truncated: this.truncated };
  }
}
