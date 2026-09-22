/**
 * How search hits are scored, tiered, de-duplicated and paged.
 *
 * The retrieval engines differ by host and stay separate: the desktop fans
 * out over SQLite full-text and vector indexes, a phone scans files. What
 * the two must agree on is everything after retrieval, because the results
 * land in one shared UI: a "strong" tier has to mean the same thing, corpus
 * priority has to order kinds the same way, and a page boundary has to be a
 * fact on both. Before this module the two hosts computed the tier two
 * different ways.
 */
import type { UnifiedSearchResult, UnifiedSearchResultKind } from './schemas/api.js';

// Per-kind merge weights — corpus PRIORITY, kept strictly separate from
// within-corpus relevance. Bias name/quick-open matches above content so a
// typed project name out-ranks a fuzzy file hit, while a strong content match
// can still surface. Multiplied by a calibrated 0..1 relevance in
// `scoreResult` to produce the merged ordering key. Typed against the full
// kind enum so a future kind is a compile error here until weighted.
export const MERGE_WEIGHTS: Record<UnifiedSearchResultKind, number> = {
  project: 1000,
  gezel: 950,
  file: 700,
  document: 680,
  // A named task beats fuzzy content — the user typed something close to its
  // title — but never a project/gezel/file name match.
  task: 640,
  // A subject-line match on the user's own mail is personal content — above
  // catalogs and symbols, below tasks.
  mail: 620,
  symbol: 520,
  craftbook: 500,
  content: 420,
  session: 400,
  // Manual articles orient, they don't answer about the user's own work.
  handboek: 380,
  // Knowledge catalogs are generic reference material: below every corpus
  // about the user's own work and below the handboek, above only memory.
  knowledge: 370,
  memory: 360,
};

/** Relevance at or above which a hit renders as high-confidence. */
export const STRONG_TIER_MIN_RELEVANCE = 0.6;

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * The single scoring seam: every result construction site routes through
 * this, so relevance stays a calibrated 0–1, tiers derive from one constant,
 * and `score` remains purely relevance × corpus priority.
 */
export function scoreResult(
  kind: UnifiedSearchResultKind,
  relevance: number,
): { relevance: number; tier: 'strong' | 'weak'; score: number } {
  const clamped = clamp01(relevance);
  return {
    relevance: clamped,
    tier: clamped >= STRONG_TIER_MIN_RELEVANCE ? 'strong' : 'weak',
    score: clamped * MERGE_WEIGHTS[kind],
  };
}

/**
 * Relevance estimate for an FTS-only corpus that reports rank order but no
 * usable score. RRF-shaped (k=10) and anchored so rank 0 = 0.6, the fixed
 * pseudo-relevance these corpora carried historically, so the top hit's
 * merged score is unchanged and later ranks decay instead of tying.
 */
export function ftsRankRelevance(rank: number): number {
  return 0.6 * (11 / (11 + rank));
}

/**
 * Relevance for a lexical scan that knows only what fraction of the query's
 * terms a text contains. Squared so that a partial match stays below the
 * strong tier: two of three terms is a lead, not an answer. Only a text
 * holding every term reaches full relevance.
 */
export function lexicalRelevance(matchedFraction: number): number {
  const f = clamp01(matchedFraction);
  return f * f;
}

/** Best score first; equal scores order by id so a page is stable across runs. */
export function compareSearchResults(a: UnifiedSearchResult, b: UnifiedSearchResult): number {
  return b.score - a.score || a.id.localeCompare(b.id);
}

/**
 * Identity of a remembered sentence for de-duplication: case- and
 * whitespace-insensitive, so the same fact written on two days collapses to
 * one row rather than reading as two separate recollections.
 */
function memoryTextKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * One row per id, and for memories one row per distinct text: a memory's id
 * carries its scope and day, so the same sentence recorded for two gezels or
 * on two days would otherwise list several times. The best-scoring copy wins
 * and keeps its own id, which is what navigation resolves against.
 */
export function dedupeSearchResults(
  results: readonly UnifiedSearchResult[],
): UnifiedSearchResult[] {
  const byId = new Map<string, UnifiedSearchResult>();
  for (const r of results) {
    const existing = byId.get(r.id);
    if (!existing || r.score > existing.score) byId.set(r.id, r);
  }
  const bestByText = new Map<string, UnifiedSearchResult>();
  const out: UnifiedSearchResult[] = [];
  for (const r of byId.values()) {
    if (r.kind !== 'memory') {
      out.push(r);
      continue;
    }
    const key = memoryTextKey(r.snippet ?? r.title);
    const existing = bestByText.get(key);
    if (!existing || r.score > existing.score) bestByText.set(key, r);
  }
  out.push(...bestByText.values());
  return out;
}

/** Sort, then cut one page; `hasMore` is a fact about what lies past it. */
export function pageSearchResults(
  results: readonly UnifiedSearchResult[],
  page: { offset?: number; limit: number },
): { results: UnifiedSearchResult[]; hasMore: boolean } {
  const offset = page.offset ?? 0;
  const sorted = [...results].sort(compareSearchResults);
  return {
    results: sorted.slice(offset, offset + page.limit),
    hasMore: sorted.length > offset + page.limit,
  };
}
