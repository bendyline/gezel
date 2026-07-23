/**
 * Building-elevation policy for the code map: importance + LoC + churn →
 * storeys (1..5) and skyline landmarks. Server-side like the health policy —
 * the renderer maps `levels`/`landmark` to geometry 1:1 and never re-derives
 * thresholds.
 *
 * Weighting rationale: importance dominates (interconnectedness = height, the
 * V3 product decision) and is max-normalized upstream so every repo's top hub
 * reaches 5 storeys; LoC is a softer secondary cue (footprint area already
 * encodes it); churn is texture and a tiebreak. Churn 0 (no git) produces
 * levels identical to a git repo with no history, so degradation is invisible.
 */

export interface ElevationSignals {
  /** Import-graph centrality, max-normalized to [0, 1]. */
  importance: number;
  loc: number;
  /** Commits in the churn window; 0 when git is unavailable. */
  churnCommits: number;
}

export const MAX_LEVELS = 5;
/** Landmark blocks read at least this tall. */
const LANDMARK_MIN_LEVELS = 4;

/** Composite prominence in [0, 1] — also the landmark ranking key. */
export function prominenceScore(sig: ElevationSignals): number {
  const locScore = Math.min(1, Math.log1p(Math.max(0, sig.loc)) / Math.log1p(4000));
  const churnScore = Math.min(1, Math.log1p(Math.max(0, sig.churnCommits)) / Math.log1p(50));
  return 0.55 * sig.importance + 0.3 * locScore + 0.15 * churnScore;
}

/** Discrete storeys 1..MAX_LEVELS. */
export function computeLevels(sig: ElevationSignals): number {
  return Math.max(1, Math.min(MAX_LEVELS, 1 + Math.round(prominenceScore(sig) * 4)));
}

/** Bump applied to blocks selected as landmarks so the skyline reads. */
export function landmarkLevels(levels: number): number {
  return Math.max(levels, LANDMARK_MIN_LEVELS);
}

export interface LandmarkCandidate {
  path: string;
  zone: string;
  importance: number;
  churnCommits: number;
}

/**
 * Landmarks are the centrality-ranked head of the civic zone — one hierarchy
 * (residential < commercial < civic < landmark) rather than two competing
 * "important" notions. `totalFiles` is the live-block count of the whole map
 * (scales K); zero civic candidates → zero landmarks.
 */
export function selectLandmarks(
  candidates: readonly LandmarkCandidate[],
  totalFiles: number,
): Set<string> {
  const civic = candidates.filter((c) => c.zone === 'civic');
  if (civic.length === 0) return new Set();
  const k = Math.min(12, Math.max(3, Math.ceil(totalFiles / 50)));
  civic.sort(
    (a, b) =>
      b.importance - a.importance ||
      b.churnCommits - a.churnCommits ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return new Set(civic.slice(0, k).map((c) => c.path));
}
