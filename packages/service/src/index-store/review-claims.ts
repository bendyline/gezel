import type { SqliteDriver } from './sqlite-driver.js';

/**
 * Detection + cleanup for spurious "this file is truncated" review claims.
 *
 * When a large file is reviewed in line-aligned windows, a mid-file window
 * genuinely stops mid-construct — and a model that ignores the part header
 * concludes the FILE is truncated, scores it 1-2/10, and that window's
 * verdict used to become the stored review (worst-window fold). The merge in
 * review.ts now filters these claims from windows that demonstrably do not
 * show the end of the file; this module holds the shared predicate plus a
 * one-shot purge of rows written before the fix existed.
 *
 * A leaf module on purpose: index-store.ts needs the predicate for the purge,
 * and importing review.ts from there would create an ESM runtime cycle via
 * enrich.ts.
 */

/**
 * Lexicon of file-level truncation/incompleteness claims. Tuned against live
 * false positives ("truncation mid-array", "cut off mid-definition",
 * "syntactically incomplete") while NOT matching genuine code-quality issues
 * ("incomplete error handling", "unclosed file handle"). Only ever applied to
 * text from windows that do not reach EOF — a whole-file review keeps its
 * truncation claims, because there they can be true.
 */
const TRUNCATION_CLAIM_RES: readonly RegExp[] = [
  /truncat/i,
  /\bcut[\s-]?off\b/i,
  /(?:ends?|stops?|terminates?)\s+abruptly/i,
  /abruptly\s+(?:ends?|stops?|terminates?)/i,
  /ends?\s+(?:mid\b|mid-|prematurely|unexpectedly)/i,
  /syntactically\s+incomplete/i,
  /(?:file|content|code)\s+(?:is|appears|seems)\s+(?:to\s+be\s+)?incomplete/i,
  /incomplete\s+file/i,
  /unterminated\s+(?:string|template|literal|array|object)/i,
  /unclosed\s+(?:bracket|brace|paren|string|template)/i,
];

export function isSpuriousTruncationClaim(text: string): boolean {
  return TRUNCATION_CLAIM_RES.some((re) => re.test(text));
}

const PURGE_META_KEY = 'truncation_claim_purge';

/**
 * One-shot deletion of multi-window reviews whose health_reason is a
 * truncation claim — rows written before the merge filter existed. Deleted
 * rows re-admit immediately via filesNeedingReview (no row for the content
 * hash), so a false 2/10 leaves worstFiles on the next review pass instead of
 * waiting for the lazy REVIEW_PROMPT_VERSION re-review of the whole corpus.
 * Safe by reconvergence: a genuinely truncated file re-reviews to the same
 * honest low score from its EOF window.
 */
export function purgeSpuriousTruncationReviews(db: SqliteDriver): void {
  const stamped = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get<{ value: string }>(PURGE_META_KEY)?.value;
  if (stamped) return;
  // The multi-part coverage marker (review.ts mergeWindowReplies) is the
  // multi-window discriminator; the lexicon can't be expressed in LIKE, so
  // filter the candidates in JS.
  const rows = db
    .prepare(
      `SELECT content_hash, health_reason FROM file_reviews
       WHERE notes_md LIKE '%(reviewed in %part%' AND health_reason IS NOT NULL`,
    )
    .all<{ content_hash: string; health_reason: string }>();
  const del = db.prepare('DELETE FROM file_reviews WHERE content_hash = ?');
  for (const row of rows) {
    if (isSpuriousTruncationClaim(row.health_reason)) del.run(row.content_hash);
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(PURGE_META_KEY, '1');
}
