/**
 * `prompt.library-recall-prelude` — surface shared-library documents that
 * bear on THIS turn's message.
 *
 * Auto-recall runs once, on a session's first message, and its snapshot is
 * frozen for the session's lifetime (re-recalling every turn would churn the
 * volatile prompt band and tax the KV cache local engines depend on). That is
 * the right call for the system prompt, and it leaves a real gap: a session
 * that opens with "let's plan the sprint" and asks "what's our refund policy"
 * eight turns later gets no retrieval at all, because the snapshot is still
 * answering turn one.
 *
 * This fills that gap on the user-message channel, where turn-scoped content
 * belongs. The manager resolves the matches before the hook runs (prelude
 * hooks are synchronous) and only passes ones above a high similarity floor,
 * so the common case is no hits, no prelude, and zero tokens.
 *
 * Deliberately advisory: the model is told the documents may be relevant and
 * invited to read one, not instructed to use them. A retrieval hit is a
 * guess about intent, and a wrong guess that reads as an order is worse than
 * one that reads as an offer.
 */

import type { Behavior } from '../types.js';

/** Keep the prelude to a couple of lines — it rides on top of a real message. */
const MAX_ROWS = 2;
const SNIPPET_MAX_CHARS = 140;

function tidy(snippet: string): string {
  const collapsed = snippet.replace(/\s+/g, ' ').trim();
  return collapsed.length > SNIPPET_MAX_CHARS
    ? `${collapsed.slice(0, SNIPPET_MAX_CHARS)}…`
    : collapsed;
}

export const PromptLibraryRecallPrelude: Behavior = {
  id: 'prompt.library-recall-prelude',
  description:
    "Prepends shared-library documents matching the current message, so a topic the session did not open with still reaches the model. Silent unless a match is strong and hasn't already been surfaced this session.",

  userPromptPrelude(ctx) {
    const hits = ctx.libraryRecall ?? [];
    if (hits.length === 0) return null;
    const canRead = ctx.availableToolNames.includes('read_document');
    const rows = hits
      .slice(0, MAX_ROWS)
      .map((hit) => `- \`${hit.path}\` — ${tidy(hit.snippet)}`)
      .join('\n');
    const follow = canRead
      ? ' Read one with `read_document` if it bears on the answer; ignore them if not.'
      : ' Use them if they bear on the answer; ignore them if not.';
    return `(From the shared document library, possibly relevant to this message:\n${rows}\n${follow})`;
  },
};
