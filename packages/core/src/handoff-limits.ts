/**
 * The two shapes a crew handoff limit takes.
 *
 * A chain: one turn hands work down a line of gezels, each the child of the
 * last. The portable host runs one turn at a time, so a linear ancestor list
 * is the whole graph. An ask graph: on the desktop, asynchronous consultations
 * form edges between gezels that can outlive a turn, so a cycle has to be
 * found by walking the in-flight edges. The constants are the host's own —
 * a phone's budget is not a workstation's — but the rules live here once.
 */
export interface HandoffChainLimits {
  /** Ancestors a turn may already have before it may hand off again. */
  maxDepth: number;
  /** Handoffs one root turn may queue in total. */
  maxCount?: number;
}

export type HandoffRefusal =
  | { kind: 'cycle' }
  | { kind: 'depth'; limit: number }
  | { kind: 'count'; limit: number };

/** Why a further handoff on this chain must be refused, or null if it may proceed. */
export function checkHandoffChain(
  input: { ancestors: readonly string[]; target?: string; count: number },
  limits: HandoffChainLimits,
): HandoffRefusal | null {
  if (input.target !== undefined && input.ancestors.includes(input.target))
    return { kind: 'cycle' };
  if (input.ancestors.length >= limits.maxDepth) return { kind: 'depth', limit: limits.maxDepth };
  if (limits.maxCount !== undefined && input.count >= limits.maxCount)
    return { kind: 'count', limit: limits.maxCount };
  return null;
}

export interface AskEdge {
  askerGezelId: string;
  targetGezelId: string;
}

/**
 * Whether adding an edge from `asker` to `target` would close a cycle in the
 * in-flight ask graph, or reach further than `maxDepth`. A breadth-first walk
 * from the target: meeting the asker at any depth is a cycle.
 */
export function findAskCycleOrDepth(
  edges: Iterable<AskEdge>,
  askerGezelId: string,
  targetGezelId: string,
  maxDepth: number,
): { kind: 'ok' } | { kind: 'cycle' } | { kind: 'depth'; maxDepth: number } {
  const out = new Map<string, Set<string>>();
  for (const edge of edges) {
    let bucket = out.get(edge.askerGezelId);
    if (!bucket) {
      bucket = new Set();
      out.set(edge.askerGezelId, bucket);
    }
    bucket.add(edge.targetGezelId);
  }
  const queue: Array<{ gezel: string; depth: number }> = [{ gezel: targetGezelId, depth: 1 }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { gezel, depth } = queue.shift()!;
    if (gezel === askerGezelId) return { kind: 'cycle' };
    if (depth > maxDepth) return { kind: 'depth', maxDepth };
    if (visited.has(gezel)) continue;
    visited.add(gezel);
    for (const next of out.get(gezel) ?? []) queue.push({ gezel: next, depth: depth + 1 });
  }
  return { kind: 'ok' };
}
