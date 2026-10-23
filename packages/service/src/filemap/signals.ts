import type { MapBlockHealth } from '@bendyline/gezel';
import {
  GIT_META_COMMITS,
  GIT_META_LAST_COMMIT,
  gitStatsAvailable,
} from '../index-store/git-stats.js';
import type { IndexStore } from '../index-store/index-store.js';
import type { ResolvedEdge } from './affinity.js';
import { computeImportance } from './centrality.js';
import { selectLandmarks } from './elevation.js';
import { civicThreshold, computeHealth, normalizeSeverity } from './health.js';

/**
 * The per-file signals every view of the import graph shares: fan-in and
 * fan-out, centrality, health and zone, and the landmark set. One function so
 * the Village, the Diagram and the reports can never disagree about which
 * file is load-bearing. Pure apart from the git and findings reads.
 */
export interface FileSignals {
  fanIn: ReadonlyMap<string, number>;
  fanOut: ReadonlyMap<string, number>;
  /** PageRank, max-normalized; empty when the graph has no edges. */
  importance: ReadonlyMap<string, number>;
  health: ReadonlyMap<string, MapBlockHealth>;
  landmarks: ReadonlySet<string>;
  hasEdges: boolean;
  gitAvailable: boolean;
  churnOf: (path: string) => number;
  lastCommitAt: (path: string) => string | undefined;
}

export interface FileSignalInput {
  /** Each file's path and line weight (the map's block weight). */
  files: ReadonlyArray<{ path: string; weight: number }>;
  edges: readonly ResolvedEdge[];
  symbolCount: (path: string) => number;
}

export function computeFileSignals(index: IndexStore, input: FileSignalInput): FileSignals {
  const findingsByFile = index.securityFindingCountsByFile();
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const e of input.edges) {
    fanOut.set(e.src, (fanOut.get(e.src) ?? 0) + 1);
    fanIn.set(e.dst, (fanIn.get(e.dst) ?? 0) + 1);
  }
  const civicFanIn = civicThreshold(input.files.map((f) => fanIn.get(f.path) ?? 0));

  const hasEdges = input.edges.length > 0;
  const importance = computeImportance(
    input.files.map((f) => f.path),
    input.edges,
  );
  const gitAvailable = gitStatsAvailable(index);
  const gitMeta = gitAvailable
    ? index.metadataValuesForKeys([GIT_META_COMMITS, GIT_META_LAST_COMMIT])
    : new Map<string, Record<string, string>>();
  const churnOf = (path: string): number => {
    const raw = gitMeta.get(path)?.[GIT_META_COMMITS];
    const n = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : 0;
  };

  // Health first (zones are pre-layout facts), then landmarks — the
  // centrality-ranked head of the civic zone.
  const health = new Map<string, MapBlockHealth>();
  for (const f of input.files) {
    const findings = findingsByFile.get(f.path);
    health.set(
      f.path,
      computeHealth(
        {
          loc: f.weight,
          symbolCount: input.symbolCount(f.path),
          findings: findings?.count ?? 0,
          maxSeverity: normalizeSeverity(findings?.maxSeverity),
          fanIn: fanIn.get(f.path) ?? 0,
          fanOut: fanOut.get(f.path) ?? 0,
          ...(hasEdges ? { importance: importance.get(f.path) ?? 0 } : {}),
          ...(gitAvailable ? { churnCommits: churnOf(f.path) } : {}),
        },
        civicFanIn,
      ),
    );
  }
  const landmarks = selectLandmarks(
    [...health.entries()].map(([path, h]) => ({
      path,
      zone: h.zone,
      importance: importance.get(path) ?? 0,
      churnCommits: churnOf(path),
    })),
    input.files.length,
  );
  return {
    fanIn,
    fanOut,
    importance,
    health,
    landmarks,
    hasEdges,
    gitAvailable,
    churnOf,
    lastCommitAt: (path) => gitMeta.get(path)?.[GIT_META_LAST_COMMIT],
  };
}
