/**
 * Recover a finished markdown deliverable the model wrote into chat
 * instead of into its write tool.
 *
 * [code-block-salvage.ts](./code-block-salvage.ts) already covers the
 * fenced case — "here's the file: ```html …```". It cannot cover a
 * *document*: a review, a report, a set of notes. Those are markdown
 * all the way down, so the model has no reason to fence them, and the
 * whole buffer is discarded when the ramble watchdog fires.
 *
 * Wild-caught (qwen3.8-27b-q4, PR-review batch step): 12 KB of review
 * whose only destination was `write_artifact` went in the bin.
 *
 * THE TRUNCATION RULE. This only ever runs on a stream the model closed
 * itself. A ramble abort that cut the stream mid-token has, by
 * definition, a truncated buffer — and promoting *that* is worse than
 * losing it, because a syntax-shaped gate (`minBytes`, `json-valid`)
 * passes a half-written document and the craftbook advances on a
 * deliverable missing most of its content. That is the same silent
 * failure as the Pull Request Review batches incident: a gate that
 * checks syntax cannot detect truncation. So: `streamComplete` is
 * required, and the tail is checked besides.
 */

/** Deliverables we will reconstruct from prose. Prose is not JSON. */
const PROSE_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'txt', 'text']);

/**
 * Below this the "document" is almost certainly a one-line apology or a
 * fragment of narration, not the deliverable.
 */
const MIN_DOCUMENT_CHARS = 200;

export interface ProseDocumentSalvageOpts {
  /** Reasoning-stripped visible content buffered this turn. */
  text: string;
  /** Exact deliverable path from the active craftbook step. */
  deliverableFile: string | undefined;
  /**
   * True only when the model ended its own stream. False for every
   * mid-stream abort — see THE TRUNCATION RULE above.
   */
  streamComplete: boolean;
}

/**
 * A buffer that stops mid-word, mid-sentence, or inside an unclosed
 * fence is not a finished document however the stream ended. Cheap
 * backstop for the case where the model emits its stop token after
 * losing the thread.
 */
function looksTruncated(text: string): boolean {
  const fences = text.match(/(?:^|\n)[ \t]*(?:```|~~~)/g);
  if (fences && fences.length % 2 === 1) return true;
  const tail = text.trimEnd();
  // An ellipsis is how these models signal they gave up mid-thought.
  if (/(?:\.\.\.|…)$/.test(tail)) return true;
  return !/[.!?:;)\]}"'`*_>|-]$/.test(tail);
}

/**
 * Is the buffer THE document, or a reply that merely contains document
 * structure? Only the first counts.
 *
 * The distinction matters because this gate is what stands between
 * "recover the review the model wrote into chat" and "overwrite the
 * deliverable with the model's commentary about it." A turn that opens
 * with narration — "I've finished reviewing the batch. Here's what I
 * found: ## Batch 11 …" — is a reply. A turn whose very first content
 * is the prescribed heading is the deliverable.
 *
 * Mirrors the intent gate `shouldPromoteCompletedCodeBlock` applies to
 * the fenced case: promote only on an explicit signal, never on shape
 * alone. The escape hatch is the model naming the deliverable itself,
 * which is the same announcement in different words.
 */
function looksLikeDocument(text: string, deliverableFile: string): boolean {
  const startsAsDocument = /^(?:#{1,6}\s+\S|\|.+\|)/.test(text);
  if (startsAsDocument) return true;
  const basename = deliverableFile.split('/').at(-1);
  return !!basename && text.includes(basename);
}

/**
 * Returns the content to write to `deliverableFile`, or null when the
 * buffer fails any gate above. Never guesses a path: without an active
 * step's deliverable there is nowhere safe to put this.
 */
export function prepareSalvagedProseDocument(opts: ProseDocumentSalvageOpts): string | null {
  const { text, deliverableFile, streamComplete } = opts;
  if (!streamComplete || !deliverableFile) return null;

  const ext = deliverableFile.split('.').at(-1)?.toLowerCase();
  if (!ext || !PROSE_EXTENSIONS.has(ext)) return null;

  const content = text.trim();
  if (content.length < MIN_DOCUMENT_CHARS) return null;
  if (!looksLikeDocument(content, deliverableFile)) return null;
  if (looksTruncated(content)) return null;

  return `${content}\n`;
}
