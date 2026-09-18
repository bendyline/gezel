import type { ChatMessage } from '@bendyline/gezel';

/**
 * Deterministic, no-LLM context force-fit.
 *
 * Summary compaction can leave a transcript over the window: on the very
 * first pressure check there may be too few messages to summarize, and for
 * ds4 its one-shot cannot even acquire an engine — ds4-server is a hard
 * singleton, so the pool's attempt to spawn a second replica for the
 * summarization call is refused. This force-fit is therefore the ACTUAL
 * overflow defense for ds4 and the floor for everyone else: shrink the
 * largest message CONTENTS (never the structure — roles / tool_calls /
 * pairing stay intact) until the transcript fits, so the next request
 * cannot trip the engine's context limit. Owned here so `ChatManager` and
 * its tests share one implementation.
 */
export const CONTEXT_FORCEFIT_RATIO = 0.8; // leave 20% of numCtx for generation + slack
export const FORCEFIT_CHARS_PER_TOKEN = 4; // matches the chars/4 token estimate in ChatManager
export const FORCEFIT_MIN_KEEP_CHARS = 2_000; // never shrink a message below this
export const FORCEFIT_MARKER = '\n\n[… truncated to fit the model context window …]\n\n';

/**
 * Middle-out truncate a message's `content` to ~`targetLen` chars, keeping a
 * head + tail around {@link FORCEFIT_MARKER}. Unchanged when already small.
 */
function truncateMessageContent(m: ChatMessage, targetLen: number): ChatMessage {
  const content = typeof m.content === 'string' ? m.content : '';
  if (content.length <= targetLen) return m;
  const keep = Math.max(0, targetLen - FORCEFIT_MARKER.length);
  const headLen = Math.ceil(keep * 0.6);
  const tailLen = keep - headLen;
  const head = content.slice(0, headLen);
  const tail = tailLen > 0 ? content.slice(content.length - tailLen) : '';
  return { ...m, content: `${head}${FORCEFIT_MARKER}${tail}` };
}

/**
 * Shrink the largest message contents until total content size ≤ `budgetChars`,
 * keeping ≥ {@link FORCEFIT_MIN_KEEP_CHARS} of any truncated message. Pure and
 * structure-preserving (only the `content` string changes), so tool-call /
 * result pairing is never broken.
 */
export function fitMessagesToBudget(
  messages: ChatMessage[],
  budgetChars: number,
): { messages: ChatMessage[]; truncatedCount: number; savedChars: number } {
  const charsOf = (m: ChatMessage) => (typeof m.content === 'string' ? m.content.length : 0);
  let total = messages.reduce((n, m) => n + charsOf(m), 0);
  if (total <= budgetChars) return { messages, truncatedCount: 0, savedChars: 0 };
  const out = messages.slice();
  // Largest content first — truncating the biggest contributors fits fastest.
  const order = out.map((m, i) => ({ i, len: charsOf(m) })).sort((a, b) => b.len - a.len);
  let truncatedCount = 0;
  let savedChars = 0;
  for (const { i, len } of order) {
    if (total <= budgetChars) break;
    if (len <= FORCEFIT_MIN_KEEP_CHARS) continue;
    const targetLen = Math.max(FORCEFIT_MIN_KEEP_CHARS, len - (total - budgetChars));
    const cut = len - targetLen;
    if (cut <= 0) continue;
    out[i] = truncateMessageContent(out[i]!, targetLen);
    total -= cut;
    savedChars += cut;
    truncatedCount += 1;
  }
  return { messages: out, truncatedCount, savedChars };
}
