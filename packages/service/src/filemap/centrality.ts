/**
 * Import-graph centrality for the code map. PageRank over the resolved
 * in-repo import edges: a file's rank flows from the files that import it,
 * weighted by *their* rank — the transitive generalization of fan-in that
 * makes "the hub everyone (indirectly) leans on" score highest.
 *
 * Deterministic by construction: nodes are indexed in sorted path order, so
 * identical inputs produce bitwise-identical float results. Cheap enough
 * (O(iters·(N+E)), ~1e6 ops at 2k files) to run fresh on every map build —
 * no cache, no invalidation surface.
 */

export interface CentralityOptions {
  damping?: number;
  maxIter?: number;
  /** L1 convergence threshold per node. */
  tolerance?: number;
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_MAX_ITER = 60;
const DEFAULT_TOLERANCE = 1e-9;

/**
 * PageRank, max-normalized to [0, 1] so the top hub is always 1.0 and the
 * scale is repo-size-independent. No edges (or no paths) → all zeros.
 */
export function computeImportance(
  paths: readonly string[],
  edges: readonly { src: string; dst: string }[],
  opts: CentralityOptions = {},
): Map<string, number> {
  const damping = opts.damping ?? DEFAULT_DAMPING;
  const maxIter = opts.maxIter ?? DEFAULT_MAX_ITER;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;

  const sorted = [...paths].sort();
  const n = sorted.length;
  const out = new Map<string, number>();
  if (n === 0) return out;

  const indexOf = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOf.set(sorted[i]!, i);

  // Dedupe (src,dst) pairs, drop edges with endpoints outside `paths`, and
  // sort — a canonical accumulation order keeps float sums bitwise identical
  // no matter how the caller ordered the input.
  const seen = new Set<number>();
  for (const e of edges) {
    const s = indexOf.get(e.src);
    const d = indexOf.get(e.dst);
    if (s === undefined || d === undefined || s === d) continue;
    seen.add(s * n + d);
  }
  const keys = [...seen].sort((a, b) => a - b);
  const srcIdx: number[] = [];
  const dstIdx: number[] = [];
  for (const key of keys) {
    srcIdx.push(Math.floor(key / n));
    dstIdx.push(key % n);
  }

  if (srcIdx.length === 0) {
    for (const p of sorted) out.set(p, 0);
    return out;
  }

  const outDegree = new Float64Array(n);
  for (const s of srcIdx) outDegree[s]! += 1;

  let rank = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  const teleport = (1 - damping) / n;

  for (let iter = 0; iter < maxIter; iter++) {
    // Dangling nodes (out-degree 0) redistribute their mass uniformly —
    // without this, rank leaks and hubs under-score.
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      if (outDegree[i] === 0) danglingMass += rank[i]!;
    }
    const base = teleport + (damping * danglingMass) / n;
    next.fill(base);
    for (let e = 0; e < srcIdx.length; e++) {
      const s = srcIdx[e]!;
      next[dstIdx[e]!]! += (damping * rank[s]!) / outDegree[s]!;
    }

    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i]! - rank[i]!);
    const tmp = rank;
    rank = next;
    next = tmp;
    if (delta < tolerance * n) break;
  }

  let maxRank = 0;
  for (let i = 0; i < n; i++) {
    if (rank[i]! > maxRank) maxRank = rank[i]!;
  }
  if (maxRank === 0) {
    for (const p of sorted) out.set(p, 0);
    return out;
  }
  for (let i = 0; i < n; i++) out.set(sorted[i]!, rank[i]! / maxRank);
  return out;
}
