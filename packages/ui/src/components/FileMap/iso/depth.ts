import type { Rect } from '@bendyline/gezel';

/**
 * Painter order for iso prisms. With a fixed view direction the order depends
 * only on the model — computed once per model and memoized by the geometry
 * cache; zero per-frame cost.
 *
 * Scalar keys (center-sum, corner-sum) have counterexamples with thin rects,
 * so this is a real topological sort over the occlusion partial order: for
 * disjoint axis-aligned footprints, A draws before B ("A behind B") iff their
 * projected images can overlap AND (A.x + A.w ≤ B.x  OR  A.y + A.h ≤ B.y).
 * Candidate pairs come from an iso-u interval sweep; rare cycles (extreme
 * aspect pinwheels — near-impossible with street-separated bounded lots) fall
 * back to front-corner-sum order for the strongly-connected remainder.
 */

const EPS = 0.01;

export interface DepthItem {
  rect: Rect;
  /** Iso-u interval of the projected image (height doesn't change u). */
  u0: number;
  u1: number;
}

/** True when a must be painted before b (a is behind b). */
function behind(a: Rect, b: Rect): boolean {
  return a.x + a.w <= b.x + EPS || a.y + a.h <= b.y + EPS;
}

/**
 * Back-to-front paint order (indices into `items`). Deterministic: ties and
 * cycle fallbacks break by front-corner sum then index.
 */
export function depthOrder(items: readonly DepthItem[]): number[] {
  const n = items.length;
  if (n <= 1) return items.map((_, i) => i);

  const frontKey = (i: number): number => {
    const r = items[i]!.rect;
    return r.x + r.w + r.y + r.h;
  };
  // Full tie order on rect VALUES (not input indices), so the painted
  // sequence is invariant under input permutation.
  const tieLess = (i: number, j: number): boolean => {
    const a = items[i]!.rect;
    const b = items[j]!.rect;
    return (
      (frontKey(i) - frontKey(j) || a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h || i - j) < 0
    );
  };

  // Sweep by u-interval to bound candidate pairs.
  const byU = items.map((_, i) => i).sort((a, b) => items[a]!.u0 - items[b]!.u0);
  const adj: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Array<number>(n).fill(0);
  const active: number[] = [];
  for (const i of byU) {
    const it = items[i]!;
    for (let k = active.length - 1; k >= 0; k--) {
      const j = active[k]!;
      if (items[j]!.u1 < it.u0) {
        active.splice(k, 1);
        continue;
      }
      const a = items[i]!.rect;
      const b = items[j]!.rect;
      const iBehindJ = behind(a, b);
      const jBehindI = behind(b, a);
      if (iBehindJ && !jBehindI) {
        adj[i]!.push(j);
        indeg[j]! += 1;
      } else if (jBehindI && !iBehindJ) {
        adj[j]!.push(i);
        indeg[i]! += 1;
      } else if (iBehindJ && jBehindI) {
        // Mutually "behind" (disjoint images or symmetric) — order by tie key.
        if (tieLess(i, j)) {
          adj[i]!.push(j);
          indeg[j]! += 1;
        } else {
          adj[j]!.push(i);
          indeg[i]! += 1;
        }
      }
      // Neither behind: projected images overlap ambiguously only in cycle
      // configurations; leave unordered (topo layer + key decide).
    }
    active.push(i);
  }

  // Kahn with a deterministic frontier (tie order on rect values).
  const pick = (frontier: number[]): number => {
    let best = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (tieLess(frontier[i]!, frontier[best]!)) best = i;
    }
    return best;
  };

  const out: number[] = [];
  const frontier: number[] = [];
  const remainingDeg = indeg.slice();
  for (let i = 0; i < n; i++) if (remainingDeg[i] === 0) frontier.push(i);
  const done = new Array<boolean>(n).fill(false);
  while (out.length < n) {
    if (frontier.length === 0) {
      // Cycle: break it by taking the not-done node with the smallest key.
      let fallback = -1;
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        if (fallback < 0 || frontKey(i) < frontKey(fallback)) fallback = i;
      }
      frontier.push(fallback);
      remainingDeg[fallback] = 0;
    }
    const idx = pick(frontier);
    const node = frontier.splice(idx, 1)[0]!;
    if (done[node]) continue;
    done[node] = true;
    out.push(node);
    for (const next of adj[node]!) {
      remainingDeg[next]! -= 1;
      if (remainingDeg[next] === 0 && !done[next]) frontier.push(next);
    }
  }
  return out;
}
