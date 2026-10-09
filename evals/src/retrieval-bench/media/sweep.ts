/**
 * Pure scoring for the media retrieval bench: rank text→media results,
 * compute recall, and replay what a cosine floor would admit.
 *
 * A media floor answers a different question than a text floor. Media rows
 * carry no query words to be grounded in, so the floor is the only thing that
 * lets the vector arm return nothing — and nearest-neighbour search always
 * returns some image. The sweep therefore reports both sides: how often the
 * right item survives, and how often an off-topic query still reaches any
 * item at all.
 */

export type MediaBenchModality = 'image' | 'audio' | 'video';

export interface ScoredMediaQuery {
  id: string;
  modality: MediaBenchModality;
  /** An off-topic query: nothing in the corpus should be returned. */
  abstain: boolean;
  /** Ids of the items that answer it (empty for abstain queries). */
  relevant: readonly string[];
  /** Cosine against every item of the modality's corpus. */
  scores: ReadonlyArray<{ id: string; cosine: number }>;
}

/** 1-based rank of the best relevant item, or null when none is relevant. */
export function bestRelevantRank(query: ScoredMediaQuery): number | null {
  if (query.relevant.length === 0) return null;
  const relevant = new Set(query.relevant);
  const sorted = [...query.scores].sort((a, b) => b.cosine - a.cosine);
  const at = sorted.findIndex((s) => relevant.has(s.id));
  return at < 0 ? null : at + 1;
}

/** Share of answerable queries whose best relevant item ranks within `k`. */
export function recallAtK(queries: readonly ScoredMediaQuery[], k: number): number {
  const answerable = queries.filter((q) => !q.abstain && q.relevant.length > 0);
  if (answerable.length === 0) return 0;
  const hits = answerable.filter((q) => {
    const rank = bestRelevantRank(q);
    return rank !== null && rank <= k;
  }).length;
  return hits / answerable.length;
}

/** Mean reciprocal rank of the best relevant item (0 when it never appears). */
export function meanReciprocalRank(queries: readonly ScoredMediaQuery[]): number {
  const answerable = queries.filter((q) => !q.abstain && q.relevant.length > 0);
  if (answerable.length === 0) return 0;
  let sum = 0;
  for (const q of answerable) {
    const rank = bestRelevantRank(q);
    if (rank !== null) sum += 1 / rank;
  }
  return sum / answerable.length;
}

export interface MediaFloorRow {
  floor: number;
  answerable: number;
  /** Answerable queries whose best relevant item clears the floor. */
  answersCleared: number;
  abstain: number;
  /** Abstain queries for which any item clears the floor. */
  offTopicCleared: number;
  /** Mean count of non-relevant items above the floor, per answerable query. */
  meanNoiseAbove: number;
}

export function sweepMediaFloor(
  queries: readonly ScoredMediaQuery[],
  floors: readonly number[],
): MediaFloorRow[] {
  const answerable = queries.filter((q) => !q.abstain && q.relevant.length > 0);
  const abstain = queries.filter((q) => q.abstain);
  return floors.map((floor) => {
    let answersCleared = 0;
    let noise = 0;
    for (const q of answerable) {
      const relevant = new Set(q.relevant);
      const best = Math.max(...q.scores.filter((s) => relevant.has(s.id)).map((s) => s.cosine));
      if (best >= floor) answersCleared++;
      noise += q.scores.filter((s) => !relevant.has(s.id) && s.cosine >= floor).length;
    }
    const offTopicCleared = abstain.filter((q) => q.scores.some((s) => s.cosine >= floor)).length;
    return {
      floor,
      answerable: answerable.length,
      answersCleared,
      abstain: abstain.length,
      offTopicCleared,
      meanNoiseAbove: answerable.length ? noise / answerable.length : 0,
    };
  });
}

/**
 * The lowest floor that lets at most `maxOffTopic` abstain queries reach any
 * item — the same rule the text calibration applies: an off-topic prompt that
 * clears the floor is a false injection, and recall is bought only after that.
 */
export function pickMediaFloor(rows: readonly MediaFloorRow[], maxOffTopic = 0): number | null {
  const ok = rows.filter((r) => r.offTopicCleared <= maxOffTopic);
  if (ok.length === 0) return null;
  return Math.min(...ok.map((r) => r.floor));
}

/** Floors from `from` to `to` in `step` increments, rounded to 3 places. */
export function floorGrid(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let f = from; f <= to + 1e-9; f += step) out.push(Math.round(f * 1000) / 1000);
  return out;
}
