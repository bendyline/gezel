export interface HybridHit {
  path: string;
  lineStart: number;
  lineEnd: number;
  kind: string;
  name?: string;
  snippet: string;
  score: number;
  source: 'vector' | 'fts';
}

export type HybridArmHit = Omit<HybridHit, 'score'>;

const HYBRID_SCORE_KNEE = 0.9;
const RRF_K = 10;
const MAX_HITS_PER_PATH = 3;

/**
 * A hybrid hit's fused rank as a 0..1 score that keeps its order: unchanged
 * up to the knee, compressed toward 1 above it, never reaching it. Every
 * score above the knee is still strong-tier.
 */
export function boundedHybridScore(rank: number): number {
  if (rank <= HYBRID_SCORE_KNEE) return Math.max(0, rank);
  return HYBRID_SCORE_KNEE + (1 - HYBRID_SCORE_KNEE) * (1 - Math.exp(HYBRID_SCORE_KNEE - rank));
}

function contributionAt(weight: number, rank: number): number {
  return (weight * (RRF_K + 1)) / (RRF_K + rank + 1);
}

/**
 * Reciprocal-rank fusion of `IndexStore.searchCodeHybrid`'s arms,
 * de-duplicated by (path, lineStart).
 *
 * `rank` orders candidates and is never capped; the reported `score` is
 * `boundedHybridScore(rank)`, which stays within 0..1 for the relevance
 * mapping without ties. Capping at 1.0 made every corroborated hit tie, and
 * the merge breaks ties by id, so they came back in path order.
 */
export class HybridFusion {
  private readonly candidates = new Map<string, HybridArmHit & { rank: number }>();

  addArm(hits: HybridArmHit[], weight: number): void {
    for (let rank = 0; rank < hits.length; rank++) {
      const hit = hits[rank]!;
      const k = `${hit.path}:${hit.lineStart}`;
      const contribution = contributionAt(weight, rank);
      const prior = this.candidates.get(k);
      if (!prior) {
        this.candidates.set(k, { ...hit, rank: contribution });
        continue;
      }
      // Preserve the richer vector excerpt when one arm found it, but let
      // corroboration from independent arms lift the candidate's rank.
      const preferred = hit.source === 'vector' && prior.source !== 'vector' ? hit : prior;
      this.candidates.set(k, { ...preferred, rank: prior.rank + contribution });
    }
  }

  /**
   * A summary describes its whole file, so a summary hit corroborates every
   * chunk already found in that file rather than standing alone at line 1,
   * where it could never meet them. Only a file no other arm found gets the
   * summary as its own entry. Apply it after the other arms for that reason:
   * as one more arm keyed at line 1, the summaries of a six-hour enrichment
   * pass reached almost no results (squisq experiment, 2026-10-20).
   */
  addSummaryArm(hits: HybridArmHit[], weight: number): void {
    for (let rank = 0; rank < hits.length; rank++) {
      const hit = hits[rank]!;
      const contribution = contributionAt(weight, rank);
      const sameFile = [...this.candidates.values()].filter((c) => c.path === hit.path);
      if (sameFile.length === 0) {
        this.candidates.set(`${hit.path}:${hit.lineStart}`, { ...hit, rank: contribution });
        continue;
      }
      for (const c of sameFile) c.rank += contribution;
    }
  }

  /** The best `limit` hits, at most three per file. */
  take(limit: number): HybridHit[] {
    const ranked = [...this.candidates.values()]
      .sort((a, b) => b.rank - a.rank)
      .map(({ rank, ...hit }) => ({ ...hit, score: boundedHybridScore(rank) }));
    const selected: HybridHit[] = [];
    const perPath = new Map<string, number>();
    for (const hit of ranked) {
      if ((perPath.get(hit.path) ?? 0) >= MAX_HITS_PER_PATH) continue;
      selected.push(hit);
      perPath.set(hit.path, (perPath.get(hit.path) ?? 0) + 1);
      if (selected.length >= limit) break;
    }
    return selected;
  }
}
