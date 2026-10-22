import type { FileReviewIssue } from '@bendyline/gezel';

/**
 * Whether a newly reported lead is an earlier one in other words. The
 * fingerprint is the exact message, so every time the local reviewer rewords
 * a lead it would otherwise become a new BW issue, and a lead someone already
 * judged "not a bug" would come back the next night as if new. The rule is
 * deliberately strict: the same category, the same named identifiers, a
 * nearby line, and most of the remaining words. "Unhandled rejection in
 * `fetchUser`" and "… in `saveUser`" are different leads. See
 * docs/issue-triage.md.
 */

const LINE_WINDOW = 15;
const MIN_WORD_OVERLAP = 0.5;
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'when',
  'not',
  'are',
  'can',
  'may',
  'its',
  'into',
  'but',
  'which',
  'will',
  'could',
  'should',
  'would',
  'there',
  'than',
  'then',
]);

export interface EchoCandidate {
  category: string;
  message: string;
  line?: number;
}

export function normalizeIssueCategory(category: string): string {
  return category
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

/** Names a lead points at: backticked text, camelCase, PascalCase with an inner capital, snake_case. */
function identifiers(message: string): Set<string> {
  const out = new Set<string>();
  for (const m of message.matchAll(/`([^`]+)`/g)) out.add((m[1] ?? '').trim());
  const bare = message.replace(/`[^`]*`/g, ' ');
  for (const m of bare.matchAll(
    /\b[A-Za-z]+[a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[a-z0-9]+_[a-z0-9_]+\b/g,
  )) {
    out.add(m[0]);
  }
  return out;
}

function words(message: string, ids: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const w of message.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !STOP.has(w) && ![...ids].some((id) => id.toLowerCase() === w)) out.add(w);
  }
  return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Word overlap in [0, 1]; two empty messages count as the same. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/** How closely a new lead repeats an earlier one, or null when it is a different lead. */
export function echoScore(
  next: FileReviewIssue | EchoCandidate,
  earlier: EchoCandidate,
): number | null {
  if (normalizeIssueCategory(next.category) !== normalizeIssueCategory(earlier.category))
    return null;
  if (next.line !== undefined && earlier.line !== undefined) {
    if (Math.abs(next.line - earlier.line) > LINE_WINDOW) return null;
  }
  const ids = identifiers(next.message);
  const earlierIds = identifiers(earlier.message);
  if (!sameSet(ids, earlierIds)) return null;
  const score = overlap(words(next.message, ids), words(earlier.message, earlierIds));
  return score >= MIN_WORD_OVERLAP ? score : null;
}

/** The earlier lead a new one repeats most closely, if any. */
export function matchEarlierLead<T extends EchoCandidate>(
  next: FileReviewIssue,
  earlier: readonly T[],
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const candidate of earlier) {
    const score = echoScore(next, candidate);
    if (score !== null && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
