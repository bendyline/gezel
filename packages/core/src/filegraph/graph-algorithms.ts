/**
 * The two graph passes a Diagram needs on every reshape, both iterative so a
 * long import chain cannot overflow the stack.
 */

/** Strongly connected components (Tarjan). `comp[v]` numbers each; `size[c]` counts members. */
export function stronglyConnected(
  n: number,
  successors: readonly (readonly number[])[],
): { comp: Int32Array; size: number[] } {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const size: number[] = [];
  const stack: number[] = [];
  const work: [number, number][] = [];
  let counter = 0;
  for (let start = 0; start < n; start++) {
    if (index[start] !== -1) continue;
    work.push([start, 0]);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const [v, edge] = frame;
      if (edge === 0) {
        index[v] = low[v] = counter++;
        stack.push(v);
        onStack[v] = 1;
      }
      const succ = successors[v]!;
      if (edge < succ.length) {
        frame[1] = edge + 1;
        const w = succ[edge]!;
        if (index[w] === -1) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]![0];
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        const c = size.length;
        let count = 0;
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp[w] = c;
          count++;
        } while (w !== v);
        size.push(count);
      }
    }
  }
  return { comp, size };
}

/**
 * Which edges a longer path already implies. `edges[k]` is `[from, to]`; an
 * edge inside a cycle is never redundant, and neither is the only path
 * between two cycles. Returns one flag per edge.
 */
export function redundantEdges(
  n: number,
  edges: readonly (readonly [number, number])[],
): boolean[] {
  const succ: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) succ[a]!.push(b);
  const { comp, size } = stronglyConnected(n, succ);
  const c = size.length;
  // Tarjan numbers components in reverse topological order: successors first.
  const compSucc: Set<number>[] = Array.from({ length: c }, () => new Set());
  for (const [a, b] of edges) {
    if (comp[a] !== comp[b]) compSucc[comp[a]!]!.add(comp[b]!);
  }
  const words = Math.ceil(c / 32);
  const closure = Array.from({ length: c }, () => new Uint32Array(words));
  for (let k = 0; k < c; k++) {
    const bits = closure[k]!;
    bits[k >> 5]! |= 1 << (k & 31);
    for (const s of compSucc[k]!) {
      const other = closure[s]!;
      for (let w = 0; w < words; w++) bits[w]! |= other[w] ?? 0;
    }
  }
  const has = (bits: Uint32Array, k: number): boolean => (bits[k >> 5]! & (1 << (k & 31))) !== 0;
  return edges.map(([a, b]) => {
    const from = comp[a]!;
    const to = comp[b]!;
    if (from === to) return false;
    for (const s of compSucc[from]!) {
      if (s !== to && has(closure[s]!, to)) return true;
    }
    return false;
  });
}
