/**
 * Incremental splitter for provider delta streams that carry reasoning
 * inline as `<think>…</think>` / `<reasoning>…</reasoning>` tags
 * (Ollama, MLX) rather than on a separate reasoning channel. Text is
 * routed to `onThinking` while inside a tag pair and `onOutput`
 * otherwise; the tags themselves are dropped, and a partial tag prefix
 * at a chunk boundary is held back until the next push resolves it.
 * An unterminated open tag streams the remainder as thinking — the
 * blocking result path already strips it from the final text, so the
 * live feed erring toward "metacommentary" is the right failure mode.
 */

const OPEN_TAGS = ['<think>', '<reasoning>'];
const CLOSE_TAGS = ['</think>', '</reasoning>'];
const ALL_TAGS = [...OPEN_TAGS, ...CLOSE_TAGS];

export interface ThinkSplitter {
  push(chunk: string): void;
  /** Drain any held-back partial tag at end of stream. */
  flush(): void;
}

export function createThinkSplitter(hooks: {
  onThinking: (text: string) => void;
  onOutput: (text: string) => void;
}): ThinkSplitter {
  let buf = '';
  let thinking = false;

  const emit = (text: string) => {
    if (!text) return;
    if (thinking) hooks.onThinking(text);
    else hooks.onOutput(text);
  };

  const process = (final: boolean) => {
    for (;;) {
      const lt = buf.indexOf('<');
      if (lt === -1) {
        emit(buf);
        buf = '';
        return;
      }
      const rest = buf.slice(lt).toLowerCase();
      const matched = ALL_TAGS.find((tag) => rest.startsWith(tag));
      if (matched) {
        emit(buf.slice(0, lt));
        buf = buf.slice(lt + matched.length);
        thinking = OPEN_TAGS.includes(matched);
        continue;
      }
      if (!final && ALL_TAGS.some((tag) => tag.startsWith(rest))) {
        emit(buf.slice(0, lt));
        buf = buf.slice(lt);
        return;
      }
      emit(buf.slice(0, lt + 1));
      buf = buf.slice(lt + 1);
    }
  };

  return {
    push(chunk: string) {
      if (!chunk) return;
      buf += chunk;
      process(false);
    },
    flush() {
      process(true);
    },
  };
}
