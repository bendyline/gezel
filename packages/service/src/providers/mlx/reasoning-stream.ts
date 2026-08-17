import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';

const log = createLogger('mlx');

/**
 * Closing markers that end a reasoning block the chat template opened for the
 * model. Kept in sync with the paired forms `extractReasoning` strips at end of
 * turn — this is the streaming half of the same knowledge.
 */
const CLOSE_MARKERS = ['</think>', '</reasoning>', '[/THINK]', '<|end|>'] as const;

/** The longest close marker, so `push` knows how much tail to hold back. */
const MAX_MARKER_LENGTH = Math.max(...CLOSE_MARKERS.map((marker) => marker.length));

/**
 * Whether the model's chat template opens a reasoning block as the last thing
 * it emits before the model starts generating.
 *
 * Qwen-family templates end their generation prompt with a bare `<think>`, so
 * the model's output begins *inside* reasoning and the only tag that ever
 * appears is the closing one. Reading the template makes that a per-model fact
 * rather than something guessed from the token stream: without it, a streamed
 * turn is ambiguous until a close marker arrives, and the choice is between
 * leaking chain-of-thought as answer text or withholding an answer that may
 * never have had a reasoning block at all.
 *
 * Unreadable or unrecognized templates return false — the caller then only
 * splits on explicit paired tags, which is unambiguous.
 */
export function templateOpensReasoning(modelDir: string): boolean {
  let template: string;
  try {
    template = readFileSync(join(modelDir, 'chat_template.jinja'), 'utf8');
  } catch {
    try {
      const config = JSON.parse(readFileSync(join(modelDir, 'tokenizer_config.json'), 'utf8')) as {
        chat_template?: unknown;
      };
      if (typeof config.chat_template !== 'string') return false;
      template = config.chat_template;
    } catch (err) {
      log.debug(`chat template unreadable in ${modelDir}: ${String(err)}`);
      return false;
    }
  }
  return templateTextOpensReasoning(template);
}

/**
 * Exposed for tests: the string-level rule applied to template text.
 *
 * Looks only at the generation-prompt tail — the branch guarded by
 * `add_generation_prompt` — because an opener anywhere else belongs to a
 * *replayed* assistant turn rather than the one about to be generated.
 */
export function templateTextOpensReasoning(template: string): boolean {
  const generationBranch = template.lastIndexOf('add_generation_prompt');
  if (generationBranch === -1) return false;
  const tail = template.slice(generationBranch);
  // The opener must be the last literal the template emits. Anything after it
  // (a closing tag, more prose) means the block is already balanced.
  const opener = /<think>|<reasoning>|\[THINK\]/gi;
  let lastOpenerEnd = -1;
  for (let match = opener.exec(tail); match; match = opener.exec(tail)) {
    lastOpenerEnd = match.index + match[0].length;
  }
  if (lastOpenerEnd === -1) return false;
  return !/<\/think>|<\/reasoning>|\[\/THINK\]/i.test(tail.slice(lastOpenerEnd));
}

export interface ReasoningSplitChunk {
  visible: string;
  reasoning: string;
}

/**
 * Incremental reasoning splitter for a streamed MLX turn.
 *
 * MLX inlines chain-of-thought in the same content deltas as the reply, and the
 * provider only separates them once the turn is complete. Everything reading
 * live deltas — Gezel's own bubble, and every connected app through the
 * OpenAI-compatible facade — therefore sees thinking rendered as the answer.
 * llama.cpp and ds4 avoid this because their engines emit a dedicated
 * `reasoning_content` channel; this class is that channel for MLX, derived on
 * our side.
 *
 * Mirrors {@link LeakyToolCallStripper}'s contract: `push` returns what is safe
 * to emit now, holding back only a trailing fragment that could still be the
 * start of a close marker; `flush` drains whatever is left at end of turn.
 */
export class StreamingReasoningSplit {
  private buffer = '';
  private inReasoning: boolean;
  private readonly enabled: boolean;

  constructor(opts: { opensInReasoning: boolean; enabled?: boolean }) {
    this.enabled = opts.enabled ?? true;
    this.inReasoning = this.enabled && opts.opensInReasoning;
  }

  push(chunk: string): ReasoningSplitChunk {
    if (!this.enabled) return { visible: chunk, reasoning: '' };
    this.buffer += chunk;
    return this.drain(false);
  }

  /**
   * End of turn. A reasoning block the model never closed stays reasoning —
   * promoting it to visible would publish exactly the chain-of-thought this
   * exists to withhold.
   */
  flush(): ReasoningSplitChunk {
    if (!this.enabled) return { visible: '', reasoning: '' };
    return this.drain(true);
  }

  private drain(final: boolean): ReasoningSplitChunk {
    let visible = '';
    let reasoning = '';

    while (this.buffer.length > 0) {
      if (this.inReasoning) {
        const close = this.firstCloseMarker();
        if (!close) break;
        reasoning += this.buffer.slice(0, close.index);
        this.buffer = this.buffer.slice(close.index + close.marker.length);
        this.inReasoning = false;
        continue;
      }
      const open = /<think>|<reasoning>|\[THINK\]/i.exec(this.buffer);
      if (!open) break;
      visible += this.buffer.slice(0, open.index);
      this.buffer = this.buffer.slice(open.index + open[0].length);
      this.inReasoning = true;
    }

    if (final) {
      if (this.inReasoning) reasoning += this.buffer;
      else visible += this.buffer;
      this.buffer = '';
      return { visible, reasoning };
    }

    // Hold back a tail that could still grow into a marker; release the rest.
    const safeLength = this.buffer.length - this.holdBackLength();
    if (safeLength > 0) {
      const released = this.buffer.slice(0, safeLength);
      this.buffer = this.buffer.slice(safeLength);
      if (this.inReasoning) reasoning += released;
      else visible += released;
    }
    return { visible, reasoning };
  }

  private firstCloseMarker(): { index: number; marker: string } | null {
    let best: { index: number; marker: string } | null = null;
    for (const marker of CLOSE_MARKERS) {
      const index = this.buffer.toLowerCase().indexOf(marker.toLowerCase());
      if (index === -1) continue;
      if (!best || index < best.index) best = { index, marker };
    }
    return best;
  }

  /** Length of the trailing fragment that could still be a partial marker. */
  private holdBackLength(): number {
    const maxTail = Math.min(MAX_MARKER_LENGTH - 1, this.buffer.length);
    for (let length = maxTail; length > 0; length -= 1) {
      const tail = this.buffer.slice(this.buffer.length - length).toLowerCase();
      const candidates = this.inReasoning
        ? CLOSE_MARKERS.map((marker) => marker.toLowerCase())
        : ['<think>', '<reasoning>', '[think]'];
      if (candidates.some((marker) => marker.startsWith(tail))) return length;
    }
    return 0;
  }
}
