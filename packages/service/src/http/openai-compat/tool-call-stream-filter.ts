/**
 * Streaming-safe filter for textual tool-call envelopes emitted by local
 * models while real tools are active.
 *
 * Some chat templates return both ordinary `content` deltas containing the
 * serialized call and a structured tool call (or content which the provider
 * promotes to one at end-of-turn). Once a content delta reaches an OpenAI
 * client it cannot be retracted, so connected agent harnesses otherwise show
 * the raw markup and then execute the same call in their normal tool UI.
 *
 * The filter is deliberately enabled only for requests that supplied tools.
 * A tool-less request may legitimately ask the model to print these tags.
 */

const OPEN_MARKERS = ['<|tool_call|>', '<|tool_call>', '<tool_call>'] as const;
const CLOSE_MARKERS = ['</tool_call|>', '<tool_call|>', '</tool_call>', '<tool_call>'] as const;

function earliestMarker(
  source: string,
  markers: readonly string[],
): { index: number; length: number } | null {
  const lower = source.toLowerCase();
  let earliest: { index: number; length: number } | null = null;
  for (const marker of markers) {
    const index = lower.indexOf(marker);
    if (index >= 0 && (earliest === null || index < earliest.index)) {
      earliest = { index, length: marker.length };
    }
  }
  return earliest;
}

/**
 * Return the first index of a trailing fragment which could become one of the
 * supplied markers when the next stream chunk arrives.
 */
function markerPrefixStart(source: string, markers: readonly string[]): number {
  const lower = source.toLowerCase();
  const longest = Math.max(...markers.map((marker) => marker.length));
  const start = Math.max(0, lower.length - longest + 1);
  for (let index = start; index < lower.length; index += 1) {
    const tail = lower.slice(index);
    if (markers.some((marker) => marker.startsWith(tail))) return index;
  }
  return lower.length;
}

export interface ToolCallStreamObserver {
  onStart(): void;
  onBodyDelta(chunk: string): void;
  onEnd(): void;
}

export class ToolCallStreamFilter {
  private buffer = '';
  private insideToolCall = false;

  constructor(private readonly observer?: ToolCallStreamObserver) {}

  /** Add one model-content delta and return the portion safe to expose. */
  push(chunk: string): string {
    this.buffer += chunk;
    return this.drain();
  }

  /**
   * Drain the final non-marker tail. An unclosed tool envelope is discarded:
   * providers may still salvage its partial arguments into a structured call,
   * and exposing it now would recreate the duplicate this filter prevents.
   */
  flush(): string {
    if (this.insideToolCall) {
      if (this.buffer) this.observer?.onBodyDelta(this.buffer);
      this.observer?.onEnd();
      this.buffer = '';
      this.insideToolCall = false;
      return '';
    }
    const output = this.buffer;
    this.buffer = '';
    return output;
  }

  private drain(): string {
    let output = '';
    while (this.buffer.length > 0) {
      if (this.insideToolCall) {
        const close = earliestMarker(this.buffer, CLOSE_MARKERS);
        if (close) {
          const body = this.buffer.slice(0, close.index);
          if (body) this.observer?.onBodyDelta(body);
          this.buffer = this.buffer.slice(close.index + close.length);
          this.insideToolCall = false;
          this.observer?.onEnd();
          continue;
        }

        // Drop body bytes that cannot form the beginning of a split closing
        // marker, retaining only the ambiguous suffix for the next chunk.
        const holdback = markerPrefixStart(this.buffer, CLOSE_MARKERS);
        const body = this.buffer.slice(0, holdback);
        if (body) this.observer?.onBodyDelta(body);
        this.buffer = this.buffer.slice(holdback);
        return output;
      }

      const open = earliestMarker(this.buffer, OPEN_MARKERS);
      if (open) {
        output += this.buffer.slice(0, open.index);
        this.buffer = this.buffer.slice(open.index + open.length);
        this.insideToolCall = true;
        this.observer?.onStart();
        continue;
      }

      const holdback = markerPrefixStart(this.buffer, OPEN_MARKERS);
      output += this.buffer.slice(0, holdback);
      this.buffer = this.buffer.slice(holdback);
      return output;
    }
    return output;
  }
}
