/**
 * Negation-aware claim detection for prose graders.
 *
 * A naive `/claim/.test(document)` gate is blind to where the claim sits.
 * Two symmetric bugs follow, and both have been wild-caught in review:
 *
 *   - False positive on a forbidden claim. "Nothing resembling the engine
 *     was completed in 1843" trips a `engine ... completed ... 1843`
 *     guard, failing a brief for being *correct*.
 *   - False negative on a required qualifier. "Lovelace was the first
 *     programmer." passes a calibration gate because the word "debate"
 *     appears three sections away, about something else.
 *
 * Both are the same problem: a claim's truth status lives in the sentence
 * carrying it, not in the document. These helpers segment on sentence and
 * line boundaries, then evaluate claim + qualifier inside one segment.
 *
 * Segment, not window: a fixed `[\s\S]{0,N}` proximity window silently
 * couples the gate to how verbosely the model writes, so the same correct
 * output passes or fails on sentence length alone.
 */

/**
 * Split prose into grading segments — sentences, and separately each line,
 * so list items and headings (which frequently carry no terminal
 * punctuation) are their own units rather than being glued to the
 * following paragraph.
 */
export function claimSegments(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * True when `claim` appears in at least one segment that does NOT also
 * carry `qualifier`. Use for forbidden claims: the qualifier is what makes
 * mentioning the claim legitimate ("the September 7 date was superseded").
 */
export function containsUnqualifiedClaim(text: string, claim: RegExp, qualifier: RegExp): boolean {
  return claimSegments(text).some((segment) => claim.test(segment) && !qualifier.test(segment));
}

/**
 * True when `claim` appears and EVERY segment carrying it also carries
 * `qualifier`. Use for claims that are only acceptable when hedged: an
 * unhedged assertion anywhere is a failure even if a hedged one exists
 * elsewhere.
 */
export function containsOnlyQualifiedClaim(
  text: string,
  claim: RegExp,
  qualifier: RegExp,
): boolean {
  const carrying = claimSegments(text).filter((segment) => claim.test(segment));
  return carrying.length > 0 && carrying.every((segment) => qualifier.test(segment));
}
