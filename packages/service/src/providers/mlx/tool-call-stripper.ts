/**
 * Streaming-safe filter for chat-template tool-call markers that leak
 * into mlx_vlm.server's content stream.
 *
 * Gemma 3+ tokenizers emit tool calls with literal special-token text
 * when the chat template doesn't fully consume them. Two open variants
 * have been observed in the wild:
 *
 *   `<|tool_call|>` — canonical, what the chat template SHOULD emit
 *   `<|tool_call>`  — short form, missing the trailing `|>`; appears on
 *                     tighter quants of Gemma 4 E4B
 *
 * Close has four observed variants: `<tool_call|>`, `</tool_call|>`,
 * `<tool_call>`, `</tool_call>`. We accept all four.
 *
 * mlx_vlm.server still ships a structured `tool_calls` delta when the
 * markers parse cleanly, but ALSO leaks the raw text. The structured
 * call is what we want; the text is noise. Stripped bodies are kept on
 * the side so a second pass can attempt repair (`parseGemmaToolCall`)
 * before falling back to a user-visible warning.
 *
 * Streaming safety: deltas can split markers across chunk boundaries,
 * so we hold back any tail that could be a prefix of any open variant
 * until enough additional bytes arrive to disambiguate. End-of-turn
 * `flush()` drops anything still inside an unclosed marker (treats it
 * as truncated noise).
 */

const OPEN_VARIANTS = ['<|tool_call|>', '<|tool_call>'] as const;
const LONGEST_OPEN = OPEN_VARIANTS.reduce((a, b) => (a.length >= b.length ? a : b));
const CLOSE_RE = /<\/?tool_call\|?>/;

export class LeakyToolCallStripper {
  private buffer = '';
  private inside = false;
  private currentBody = '';
  private readonly bodies: string[] = [];
  /**
   * Indices into {@link bodies} that came from an EOS-flush (no
   * `</tool_call>` close marker arrived before the stream ended).
   * Layer 3 reads this to decide whether a successfully-parsed Gemma
   * marker call should also be tagged as truncated — its `content`
   * arg may be partial, in which case the auto-continuation hint
   * should fire on the tool result.
   */
  private readonly eosFlushedIndices: Set<number> = new Set();

  /**
   * Push a streamed chunk and return whatever's safe to emit. Holds
   * back any trailing fragment that could be the start of a marker
   * until enough additional bytes arrive to disambiguate.
   */
  push(chunk: string): string {
    this.buffer += chunk;
    return this.drain();
  }

  /**
   * Final drain at end-of-turn. If we're still mid-marker the model
   * never finished closing it — drop the buffered content as noise
   * rather than leak a half-marker.
   */
  flush(): string {
    if (this.inside) {
      // Unclosed marker — its body still goes into the bodies list so
      // the parser/warning layer above can act on the model's intent
      // even though the close tag never arrived. Tag the index as
      // EOS-flushed so the provider knows to wire continuation-hint
      // behavior (Layer 3).
      if (this.currentBody.length > 0 || this.buffer.length > 0) {
        const idx = this.bodies.length;
        this.bodies.push((this.currentBody + this.buffer).trim());
        this.eosFlushedIndices.add(idx);
      }
      this.buffer = '';
      this.currentBody = '';
      this.inside = false;
      return '';
    }
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  /**
   * Bodies of all complete (or unclosed-at-flush) marker spans seen
   * this stream. Surface area for `parseGemmaToolCall`.
   */
  getStrippedBodies(): readonly string[] {
    return this.bodies;
  }

  /**
   * Indices into {@link getStrippedBodies}() that came from an
   * EOS-flush — i.e. the close marker never arrived. Used by the
   * provider's Layer 3 truncation-salvage logic to tag those parsed
   * calls with the continuation-hint behavior even when they parsed
   * successfully (since their string args may be partial).
   */
  getEosFlushedBodyIndices(): ReadonlySet<number> {
    return this.eosFlushedIndices;
  }

  private drain(): string {
    let emitted = '';
    while (this.buffer.length > 0) {
      if (this.inside) {
        const closeMatch = this.buffer.match(CLOSE_RE);
        if (closeMatch?.index !== undefined) {
          this.currentBody += this.buffer.slice(0, closeMatch.index);
          this.bodies.push(this.currentBody.trim());
          this.currentBody = '';
          this.buffer = this.buffer.slice(closeMatch.index + closeMatch[0].length);
          this.inside = false;
          continue;
        }
        // Close not seen yet — capture what we have, hold the rest.
        // We need to keep enough trailing bytes that a partial close
        // marker isn't accidentally split across capture and buffer.
        // The longest close pattern is `</tool_call|>` at 13 chars;
        // hold back that much from the end.
        const safeBodyEnd = Math.max(0, this.buffer.length - 13);
        this.currentBody += this.buffer.slice(0, safeBodyEnd);
        this.buffer = this.buffer.slice(safeBodyEnd);
        return emitted;
      }

      // Not inside — find earliest open across all variants.
      let openIdx = -1;
      let openLen = 0;
      for (const variant of OPEN_VARIANTS) {
        const idx = this.buffer.indexOf(variant);
        if (idx >= 0 && (openIdx < 0 || idx < openIdx)) {
          openIdx = idx;
          openLen = variant.length;
        }
      }
      if (openIdx >= 0) {
        emitted += this.buffer.slice(0, openIdx);
        this.buffer = this.buffer.slice(openIdx + openLen);
        this.inside = true;
        continue;
      }

      // No complete open marker. Find the earliest position whose
      // suffix is a prefix of any open variant — that's our holdback.
      const startScan = Math.max(0, this.buffer.length - LONGEST_OPEN.length);
      let holdback = this.buffer.length;
      for (let i = startScan; i < this.buffer.length; i++) {
        const tail = this.buffer.slice(i);
        if (OPEN_VARIANTS.some((v) => v.startsWith(tail))) {
          holdback = i;
          break;
        }
      }
      emitted += this.buffer.slice(0, holdback);
      this.buffer = this.buffer.slice(holdback);
      return emitted;
    }
    return emitted;
  }
}
