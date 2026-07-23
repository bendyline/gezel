import type { FileMapResponse, Rect } from '@bendyline/gezel';

/**
 * Route the selected block's import roads along the actual street grid instead
 * of straight through buildings. The streets ship as axis-aligned rects with a
 * tier; we lift them into a graph (intersections = nodes, street runs = edges)
 * and Dijkstra a Manhattan path between the two blocks. Edge cost scales with
 * tier so the router prefers wide avenues over alleys — traffic takes the
 * trunk roads. Everything is world-space and memoized per (model, selection),
 * so this runs on selection change, not per frame.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface RoutedRoad {
  points: Pt[];
  bidirectional: boolean;
  affinity: number;
}

interface Seg {
  axis: 'h' | 'v';
  /** The fixed coordinate: y for a horizontal street, x for a vertical one. */
  line: number;
  min: number;
  max: number;
  tier: number;
}

interface StreetGraph {
  adj: Map<string, Array<{ to: string; w: number }>>;
  coord: Map<string, Pt>;
  segs: Array<{ seg: Seg; pts: number[] }>;
}

// Lower tier (wider street) is cheaper, so the shortest path favors avenues.
const TIER_COST = [1, 1.15, 1.35, 1.6];
const EPS = 0.5;
/** Skip routing on pathological maps — the O(H·V) intersection scan gets big. */
const MAX_STREETS = 6000;
/** Cap Dijkstra runs per selection; a civic hub can have hundreds of edges. */
const MAX_ROUTED = 80;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const key = (x: number, y: number): string =>
  `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const tierCost = (t: number): number => TIER_COST[t] ?? 1;
const nodeAtSeg = (s: Seg, p: number): Pt =>
  s.axis === 'h' ? { x: p, y: s.line } : { x: s.line, y: p };
/** Max gap a bridge connector spans — covers a folder's padding + label gutter. */
const BRIDGE = 20;

function buildGraph(model: FileMapResponse): StreetGraph | null {
  const streets = model.streets;
  if (!streets || streets.length === 0 || streets.length > MAX_STREETS) return null;

  const segs: Seg[] = [];
  for (const s of streets) {
    const { x, y, w, h } = s.rect;
    if (w >= h) segs.push({ axis: 'h', line: y + h / 2, min: x, max: x + w, tier: s.tier });
    else segs.push({ axis: 'v', line: x + w / 2, min: y, max: y + h, tier: s.tier });
  }

  // Split positions along each street: its endpoints plus every crossing.
  const along = segs.map((s) => new Set<number>([s.min, s.max]));
  const hs: number[] = [];
  const vs: number[] = [];
  segs.forEach((s, i) => (s.axis === 'h' ? hs : vs).push(i));
  for (const hi of hs) {
    const h = segs[hi]!;
    for (const vi of vs) {
      const v = segs[vi]!;
      if (
        v.line >= h.min - EPS &&
        v.line <= h.max + EPS &&
        h.line >= v.min - EPS &&
        h.line <= v.max + EPS
      ) {
        along[hi]!.add(clamp(v.line, h.min, h.max));
        along[vi]!.add(clamp(h.line, v.min, v.max));
      }
    }
  }

  // District padding leaves small gaps between a folder's internal lanes and
  // the avenues around it, so the raw crossing graph is disconnected. Bridge
  // each street's endpoint to the nearest perpendicular street within BRIDGE
  // with an axis-aligned connector — a T-junction where a lane meets an avenue.
  const bridges: Array<{ a: Pt; b: Pt; w: number }> = [];
  const bridgeEndpoint = (si: number, endAlong: number): void => {
    const s = segs[si]!;
    const ep = nodeAtSeg(s, endAlong);
    const perps = s.axis === 'h' ? vs : hs;
    let best: { proj: Pt; w: number; ti: number } | null = null;
    for (const pi of perps) {
      const p = segs[pi]!;
      // p is perpendicular: for horizontal s, p is vertical (line = x).
      const along0 = s.axis === 'h' ? ep.y : ep.x; // coord that must lie on p
      if (along0 < p.min - EPS || along0 > p.max + EPS) continue;
      const gap = Math.abs(p.line - endAlong);
      if (gap <= EPS || gap > BRIDGE) continue;
      if (!best || gap < best.w) {
        const proj = s.axis === 'h' ? { x: p.line, y: ep.y } : { x: ep.x, y: p.line };
        best = { proj, w: gap, ti: pi };
      }
    }
    if (best) {
      const p = segs[best.ti]!;
      const projAlong = p.axis === 'h' ? best.proj.x : best.proj.y;
      along[best.ti]!.add(clamp(projAlong, p.min, p.max));
      bridges.push({ a: ep, b: best.proj, w: best.w * tierCost(Math.max(s.tier, p.tier)) });
    }
  };
  segs.forEach((s, i) => {
    if (s.max - s.min < 0.1) return;
    bridgeEndpoint(i, s.min);
    bridgeEndpoint(i, s.max);
  });

  const adj = new Map<string, Array<{ to: string; w: number }>>();
  const coord = new Map<string, Pt>();
  const segOut: Array<{ seg: Seg; pts: number[] }> = [];
  const addEdge = (a: string, b: string, w: number): void => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, w });
    (adj.get(b) ?? adj.set(b, []).get(b)!).push({ to: a, w });
  };
  segs.forEach((s, i) => {
    const pts = [...along[i]!].sort((a, b) => a - b);
    if (s.max - s.min < 0.1) {
      segOut.push({ seg: s, pts });
      return;
    }
    for (const p of pts) {
      const n = nodeAtSeg(s, p);
      coord.set(key(n.x, n.y), n);
    }
    const cost = tierCost(s.tier);
    for (let j = 0; j < pts.length - 1; j++) {
      const a = nodeAtSeg(s, pts[j]!);
      const b = nodeAtSeg(s, pts[j + 1]!);
      const w = (pts[j + 1]! - pts[j]!) * cost;
      if (w > 0) addEdge(key(a.x, a.y), key(b.x, b.y), w);
    }
    segOut.push({ seg: s, pts });
  });

  for (const br of bridges) {
    addEdge(key(br.a.x, br.a.y), key(br.b.x, br.b.y), br.w);
  }

  return { adj, coord, segs: segOut };
}

/** Nearest point on the street grid to a block center + which street it's on. */
function nearestExit(
  graph: StreetGraph,
  c: Pt,
): { segIndex: number; seg: Seg; along: number; point: Pt } | null {
  let best: { segIndex: number; seg: Seg; along: number; point: Pt } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  graph.segs.forEach((entry, idx) => {
    const s = entry.seg;
    if (s.max - s.min < 0.1) return;
    const a = clamp(s.axis === 'h' ? c.x : c.y, s.min, s.max);
    const point = s.axis === 'h' ? { x: a, y: s.line } : { x: s.line, y: a };
    const d = Math.hypot(c.x - point.x, c.y - point.y);
    if (d < bestD) {
      bestD = d;
      best = { segIndex: idx, seg: s, along: a, point };
    }
  });
  return best;
}

/** The two graph nodes bracketing `along` on a street, with along-street costs. */
function bracketEdges(
  entry: { seg: Seg; pts: number[] },
  along: number,
): Array<{ key: string; w: number }> {
  const { seg, pts } = entry;
  const cost = tierCost(seg.tier);
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1]! < along) i++;
  const lo = pts[i]!;
  const hi = pts[i + 1] ?? lo;
  const keyAt = (p: number): string => (seg.axis === 'h' ? key(p, seg.line) : key(seg.line, p));
  const out = [{ key: keyAt(lo), w: Math.abs(along - lo) * cost }];
  if (hi !== lo) out.push({ key: keyAt(hi), w: Math.abs(hi - along) * cost });
  return out;
}

class MinHeap {
  private a: Array<[number, string]> = [];
  get size(): number {
    return this.a.length;
  }
  push(p: number, k: string): void {
    const a = this.a;
    a.push([p, k]);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]![0] <= a[i]![0]) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      i = parent;
    }
  }
  pop(): [number, string] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l]![0] < a[s]![0]) s = l;
        if (r < a.length && a[r]![0] < a[s]![0]) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i]!, a[s]!];
        i = s;
      }
    }
    return top;
  }
}

function dijkstra(
  neighbors: (k: string) => Array<{ to: string; w: number }>,
  start: string,
  goal: string,
): string[] | null {
  const dist = new Map<string, number>([[start, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  const heap = new MinHeap();
  heap.push(0, start);
  while (heap.size > 0) {
    const [d, u] = heap.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === goal) break;
    for (const { to, w } of neighbors(u)) {
      const nd = d + w;
      if (nd < (dist.get(to) ?? Number.POSITIVE_INFINITY)) {
        dist.set(to, nd);
        prev.set(to, u);
        heap.push(nd, to);
      }
    }
  }
  if (!dist.has(goal)) return null;
  const path: string[] = [];
  let c: string | undefined = goal;
  while (c !== undefined) {
    path.push(c);
    if (c === start) break;
    c = prev.get(c);
  }
  if (path[path.length - 1] !== start) return null;
  return path.reverse();
}

/** Border point of a rect nearest a target — where a spur meets the block. */
function edgePoint(rect: Rect, toward: Pt): Pt {
  return {
    x: clamp(toward.x, rect.x, rect.x + rect.w),
    y: clamp(toward.y, rect.y, rect.y + rect.h),
  };
}

/** Drop collinear midpoints so the polyline is just its corners. */
function simplify(pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts;
  const out: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const colinear =
      (Math.abs(a.x - b.x) < 0.1 && Math.abs(b.x - c.x) < 0.1) ||
      (Math.abs(a.y - b.y) < 0.1 && Math.abs(b.y - c.y) < 0.1);
    if (!colinear && (Math.abs(a.x - b.x) > 0.1 || Math.abs(a.y - b.y) > 0.1)) out.push(b);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** A Manhattan path from block `a` to block `b` along the streets, or null. */
export function routeThroughStreets(graph: StreetGraph, a: Rect, b: Rect): Pt[] | null {
  const ea = nearestExit(graph, center(a));
  const eb = nearestExit(graph, center(b));
  if (!ea || !eb) return null;

  const A = ' A';
  const B = ' B';
  const temp = new Map<string, Array<{ to: string; w: number }>>();
  const push = (from: string, e: { to: string; w: number }): void => {
    (temp.get(from) ?? temp.set(from, []).get(from)!).push(e);
  };
  for (const e of bracketEdges(graph.segs[ea.segIndex]!, ea.along)) push(A, { to: e.key, w: e.w });
  for (const e of bracketEdges(graph.segs[eb.segIndex]!, eb.along)) push(e.key, { to: B, w: e.w });
  if (ea.segIndex === eb.segIndex) {
    push(A, { to: B, w: Math.abs(ea.along - eb.along) * tierCost(ea.seg.tier) });
  }

  const neighbors = (k: string): Array<{ to: string; w: number }> => [
    ...(graph.adj.get(k) ?? []),
    ...(temp.get(k) ?? []),
  ];
  const path = dijkstra(neighbors, A, B);
  if (!path) return null;

  const coordOf = (k: string): Pt =>
    k === A ? ea.point : k === B ? eb.point : graph.coord.get(k)!;
  const mid = path.map(coordOf);
  const start = edgePoint(a, mid[0]!);
  const end = edgePoint(b, mid[mid.length - 1]!);
  return simplify([start, ...mid, end]);
}

/** A two-segment Manhattan elbow between block centers (edge to edge). */
function manhattanL(a: Rect, b: Rect): Pt[] {
  const ca = center(a);
  const cb = center(b);
  if (Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y)) {
    return [
      { x: cb.x > ca.x ? a.x + a.w : a.x, y: ca.y },
      { x: cb.x, y: ca.y },
      { x: cb.x, y: cb.y > ca.y ? b.y : b.y + b.h },
    ];
  }
  return [
    { x: ca.x, y: cb.y > ca.y ? a.y + a.h : a.y },
    { x: ca.x, y: cb.y },
    { x: cb.x > ca.x ? b.x : b.x + b.w, y: cb.y },
  ];
}

const graphCache = new WeakMap<FileMapResponse, StreetGraph | null>();
const routeCache = new WeakMap<FileMapResponse, Map<string, RoutedRoad[] | null>>();

function getGraph(model: FileMapResponse): StreetGraph | null {
  if (graphCache.has(model)) return graphCache.get(model) ?? null;
  const g = buildGraph(model);
  graphCache.set(model, g);
  return g;
}

/**
 * The selected block's incident roads, each routed through the street grid.
 * Returns null when the map has no street geometry (old payloads) so the
 * caller can fall back to straight L-routes. Memoized per (model, selectedId).
 */
export function routedRoadsFor(
  model: FileMapResponse,
  selectedId: string,
  rectById: Map<string, Rect>,
): RoutedRoad[] | null {
  const graph = getGraph(model);
  if (!graph) return null;

  let cache = routeCache.get(model);
  if (!cache) {
    cache = new Map();
    routeCache.set(model, cache);
  }
  if (cache.has(selectedId)) return cache.get(selectedId) ?? null;

  const out: RoutedRoad[] = [];
  let routed = 0;
  for (const r of model.roads) {
    if (r.a !== selectedId && r.b !== selectedId) continue;
    const ra = rectById.get(r.a);
    const rb = rectById.get(r.b);
    if (!ra || !rb) continue;
    let points: Pt[] | null = null;
    if (routed < MAX_ROUTED) {
      points = routeThroughStreets(graph, ra, rb);
      routed++;
    }
    // Fall back to a Manhattan L (never a diagonal) when the two blocks land in
    // disconnected pieces of the street graph — still reads as streets.
    if (!points) points = manhattanL(ra, rb);
    out.push({ points, bidirectional: r.bidirectional, affinity: r.affinity });
  }
  cache.set(selectedId, out);
  return out;
}
