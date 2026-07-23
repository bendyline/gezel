import type { GoldenQuery, QueryMatchLevel } from './corpus.ts';

/**
 * Pure scoring for the index bench: retrieval quality (recall@k, MRR) for
 * golden queries against ranked tool results, and the tolerant-but-honest
 * path matcher shared with the codebase-QA answer grader.
 */

/**
 * Does `candidate` (a real result path OR a free-text mention) refer to the
 * expected file? `dir+basename` requires the last two path segments (slash-
 * agnostic); `basename` accepts the bare filename — only safe when the
 * corpus validator asserted the basename is unique.
 */
export function matchesExpected(
  candidate: string,
  expected: string,
  matchLevel: QueryMatchLevel,
): boolean {
  const clean = candidate.replaceAll('\\', '/').replaceAll('`', '');
  const parts = expected.split('/');
  const basename = parts[parts.length - 1]!;
  if (matchLevel === 'basename') return clean.includes(basename);
  const dirBase = parts.slice(-2).join('/');
  return clean.includes(dirBase);
}

export interface QueryOutcome {
  query: string;
  /** 1-based rank of the first expected hit, or null when absent. */
  rank: number | null;
}

export function scoreQuery(rankedPaths: string[], q: GoldenQuery): QueryOutcome {
  for (let i = 0; i < rankedPaths.length; i++) {
    const path = rankedPaths[i]!;
    if (q.expected.some((exp) => matchesExpected(path, exp, 'dir+basename'))) {
      return { query: q.query, rank: i + 1 };
    }
  }
  return { query: q.query, rank: null };
}

export interface RetrievalScore {
  recallAt1: number;
  recallAt5: number;
  mrr: number;
  outcomes: QueryOutcome[];
}

export function scoreRetrieval(outcomes: QueryOutcome[]): RetrievalScore {
  const n = Math.max(outcomes.length, 1);
  const at1 = outcomes.filter((o) => o.rank !== null && o.rank <= 1).length / n;
  const at5 = outcomes.filter((o) => o.rank !== null && o.rank <= 5).length / n;
  const mrr = outcomes.reduce((sum, o) => sum + (o.rank ? 1 / o.rank : 0), 0) / n;
  return { recallAt1: at1, recallAt5: at5, mrr, outcomes };
}
