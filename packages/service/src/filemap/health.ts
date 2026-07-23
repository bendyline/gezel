import type { MapBlockHealth } from '@bendyline/gezel';

/**
 * Map health + zoning policy. All thresholds live here (server-side) so they
 * can evolve without touching the renderer — the client draws `vibe`/`zone`
 * 1:1. Signals come from what the index already gathers: security findings,
 * LoC, symbol counts, and the resolved in-repo import graph.
 */

const SEVERITY_RANK: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export type Severity = NonNullable<MapBlockHealth['maxSeverity']>;

/** Clamp arbitrary tool severities to the wire enum (unknown → null). */
export function normalizeSeverity(sev: string | null | undefined): Severity | null {
  if (!sev) return null;
  const s = sev.toLowerCase();
  return s in SEVERITY_RANK ? (s as Severity) : null;
}

export function severityRank(sev: string | null | undefined): number {
  return sev ? (SEVERITY_RANK[sev.toLowerCase()] ?? 0) : 0;
}

export interface HealthSignals {
  loc: number;
  symbolCount: number;
  findings: number;
  maxSeverity: Severity | null;
  fanIn: number;
  fanOut: number;
  /** Import-graph centrality [0,1]; undefined when the map has no edges. */
  importance?: number;
  /** Commits in the churn window; undefined when git is unavailable. */
  churnCommits?: number;
}

/** Files with at least this LoC read as industrial complexes. */
const INDUSTRIAL_LOC = 1000;
/** Files this long stop being "well-kept" even without findings. */
const SCRUFFY_LOC = 800;
/** Fan-in for the commercial (widely imported) zone. */
const COMMERCIAL_FAN_IN = 3;
/** Civic zone floor; the effective threshold is max(this, p95 of fan-in). */
const CIVIC_FAN_IN_FLOOR = 8;

/**
 * The civic-landmark fan-in threshold for one map: p95 of the positive
 * fan-ins, floored — so a tiny repo doesn't crown half its files.
 */
export function civicThreshold(fanIns: Iterable<number>): number {
  const pos = [...fanIns].filter((v) => v > 0).sort((a, b) => a - b);
  if (pos.length === 0) return CIVIC_FAN_IN_FLOOR;
  const p95 = pos[Math.min(pos.length - 1, Math.floor(pos.length * 0.95))]!;
  return Math.max(CIVIC_FAN_IN_FLOOR, p95);
}

export function computeHealth(sig: HealthSignals, civicFanIn: number): MapBlockHealth {
  const { loc, symbolCount, findings, maxSeverity, fanIn, fanOut } = sig;
  const passthrough: Pick<MapBlockHealth, 'importance' | 'churn'> = {
    ...(sig.importance !== undefined
      ? { importance: Math.round(sig.importance * 10000) / 10000 }
      : {}),
    ...(sig.churnCommits !== undefined ? { churn: sig.churnCommits } : {}),
  };

  const severe = maxSeverity === 'critical' || maxSeverity === 'high';
  const vibe: MapBlockHealth['vibe'] =
    findings > 0 && severe
      ? 'blighted'
      : findings > 0 || loc > SCRUFFY_LOC
        ? 'scruffy'
        : loc <= 400 && symbolCount > 0 && fanIn >= 1
          ? 'lush'
          : symbolCount === 0 && fanIn === 0 && fanOut === 0
            ? 'plain'
            : 'tidy';

  const zone: MapBlockHealth['zone'] =
    fanIn >= civicFanIn
      ? 'civic'
      : loc > INDUSTRIAL_LOC
        ? 'industrial'
        : fanIn >= COMMERCIAL_FAN_IN
          ? 'commercial'
          : 'residential';

  return { findings, maxSeverity, fanIn, fanOut, vibe, zone, ...passthrough };
}
