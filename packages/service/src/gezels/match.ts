/**
 * Fuzzy job-title matching for `ensureGezel`.
 *
 * The match is deliberately *conservative* and deterministic. It normalizes
 * the caller's `jobTitle` into a set of role-ish tokens (with a small
 * hand-curated alias map: `dev` → `developer`, `ux` → `designer`, etc.),
 * scores it against each candidate gezel's own role/name/tags/description,
 * and returns the best score. The caller chooses a threshold (default 0.5)
 * below which we treat the roster as having no fit and fall through to
 * creation.
 *
 * Tuning: if the map turns out to over-collapse (voormen routinely asking
 * for "UX researcher" when the project already has a "Visual designer"),
 * narrow the aliases. If it under-collapses (voormen keep spinning up
 * duplicate "engineer" + "developer" gezels), add more synonyms.
 */

/**
 * One canonical role → every way callers might refer to it. The key is
 * the canonical token; values are the aliases we collapse to it.
 *
 * Deliberately short — better to miss an unusual job title and create a
 * new gezel than to over-match and reuse the wrong one. Add entries as
 * we see real regressions.
 */
export const ROLE_ALIASES: Record<string, string[]> = {
  developer: ['dev', 'engineer', 'programmer', 'coder', 'swe'],
  designer: ['ui', 'ux', 'uxui', 'uiux', 'visual', 'graphic', 'product'],
  planner: ['pm', 'strategist', 'manager'],
  copywriter: ['writer', 'content', 'wordsmith', 'editor'],
  reviewer: ['qa', 'tester', 'critic'],
  voorman: ['foreman', 'lead', 'manager'],
  meester: ['concierge', 'guildmaster', 'host'],
};

/** Invert the alias map for fast lookup: `dev` → `developer`, etc. */
const ALIAS_TO_CANONICAL: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(ROLE_ALIASES)) {
    out[canonical] = canonical;
    for (const alias of aliases) out[alias] = canonical;
  }
  return out;
})();

/**
 * Normalize + tokenize an arbitrary string into a canonicalized set of
 * role-ish tokens. Lowercases, splits on non-word chars, drops stopwords,
 * and expands known aliases into their canonical form.
 */
export function roleTokens(text: string): Set<string> {
  if (!text) return new Set();
  const raw = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  const out = new Set<string>();
  for (const token of raw) {
    const canonical = ALIAS_TO_CANONICAL[token] ?? token;
    out.add(canonical);
  }
  return out;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'for',
  'of',
  'to',
  'and',
  'or',
  'with',
  'on',
  'in',
  'by',
  'as',
  'at',
  'role',
  'type',
  'kind',
  'gezel',
  'agent',
  'assistant',
  'sub',
  'some',
  'any',
  'new',
]);

export interface MatchCandidate {
  id: string;
  /** Primary signal. */
  role?: string;
  /** Secondary — picks up display variants. */
  name?: string;
  /** Secondary — manifest tags for gilde items. */
  tags?: string[];
  /** Tertiary — free text from description / about first line. */
  description?: string;
}

export interface MatchScore {
  id: string;
  score: number;
  /** Which token set(s) contributed — useful for debugging the match. */
  matched: string[];
}

/**
 * Score a candidate against a query. Role matches count most; tags and
 * name next; description last. Score is in [0, 1].
 *
 * Scoring: weighted Jaccard overlap. If the canonical query tokens are a
 * subset of the candidate's combined tokens, that's a strong match.
 */
export function scoreCandidate(query: string, candidate: MatchCandidate): MatchScore {
  const queryTokens = roleTokens(query);
  if (queryTokens.size === 0) return { id: candidate.id, score: 0, matched: [] };

  const roleTokensSet = roleTokens(candidate.role ?? '');
  const nameTokensSet = roleTokens(candidate.name ?? '');
  const tagTokensSet = new Set<string>();
  for (const t of candidate.tags ?? []) for (const tok of roleTokens(t)) tagTokensSet.add(tok);
  const descTokensSet = roleTokens(candidate.description ?? '');

  const matched: string[] = [];
  let score = 0;
  for (const q of queryTokens) {
    if (roleTokensSet.has(q)) {
      score += 1.0;
      matched.push(`role:${q}`);
    } else if (tagTokensSet.has(q)) {
      score += 0.8;
      matched.push(`tag:${q}`);
    } else if (nameTokensSet.has(q)) {
      score += 0.5;
      matched.push(`name:${q}`);
    } else if (descTokensSet.has(q)) {
      score += 0.3;
      matched.push(`desc:${q}`);
    }
  }
  // Normalize by the number of query tokens so "designer" vs "designer"
  // = 1.0 but "senior UX designer" vs "designer" is still near-1 once
  // ux/senior collapse.
  const normalized = score / queryTokens.size;
  return { id: candidate.id, score: normalized, matched };
}

/**
 * Rank candidates, returning the best-scoring first. Ties broken by the
 * candidate's own ID (stable ordering).
 */
export function rankCandidates(query: string, candidates: MatchCandidate[]): MatchScore[] {
  const scored = candidates.map((c) => scoreCandidate(query, c));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });
  return scored;
}

/**
 * Match threshold used by `ensureGezel` to decide roster-reuse vs.
 * template vs. bespoke. 0.5 means "at least half of the query tokens
 * hit on role/tag/name/description, weighted". Intentionally a plain
 * constant — tune it here when real sessions misbehave rather than
 * scattering magic numbers across callers.
 */
export const MATCH_THRESHOLD = 0.5;
