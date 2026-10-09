import {
  type SecurityFindingWire,
  type SecurityScanProvenance,
  SecurityScanProvenanceSchema,
} from '@bendyline/gezel';
import type { SecurityFindingRow, SecuritySeverity } from './index-store-types.js';
import type { IndexStore } from './index-store.js';

/**
 * Security-intel helpers behind `ContentIndex`: the attack surface derived
 * from paths and persisted findings, import-graph reachability for taint
 * tracing, severity ordering, and the finding wire shape.
 */

export const EMPTY_COUNTS = { total: 0, bySeverity: {}, byCategory: {}, bySource: {} };

/**
 * The persisted provenance of the last security_scan, as a spreadable
 * optional field. Absent (empty object) on pre-provenance databases and on
 * unparseable values — the renderer treats absence as "provenance unknown".
 */
export function maybeScanProvenance(index: IndexStore): { provenance?: SecurityScanProvenance } {
  const raw = index.getMeta('security_scan_provenance');
  if (!raw) return {};
  try {
    return { provenance: SecurityScanProvenanceSchema.parse(JSON.parse(raw)) };
  } catch {
    return {};
  }
}

const ENTRY_RE =
  /(^|\/)(index|main|app|server|cli|worker|handler)\.(ts|tsx|js|mjs|cjs|py|go|rs|rb|php|java)$/i;
const ROUTE_PATH_RE = /(^|\/)(routes?|controllers?|handlers?|endpoints?|api|resolvers?)\//i;
const AUTH_PATH_RE =
  /(^|\/)(auth|authn|authz|middleware|guards?|permissions?|rbac|acl|session|login|oauth)([./]|$)/i;
const SECRET_PATH_RE = /(^|\/)(\.env|config|secrets?|credentials?|keys?)([./]|$)/i;
export const SINK_CATEGORIES = new Set([
  'injection',
  'command-injection',
  'xss',
  'ssrf',
  'path-traversal',
  'deserialization',
  'crypto',
]);

export interface AttackSurface {
  entryPoints: string[];
  routes: string[];
  authBoundaries: string[];
  secretTouchpoints: string[];
  taintSources: Array<{ path: string; count: number }>;
}

/** Derive the attack surface from file paths + persisted findings (no content read). */
export function computeAttackSurface(
  files: string[],
  findings: SecurityFindingRow[],
): AttackSurface {
  const routes = new Set<string>();
  const auth = new Set<string>();
  const secrets = new Set<string>();
  const entry: string[] = [];
  for (const p of files) {
    if (ENTRY_RE.test(p)) entry.push(p);
    if (ROUTE_PATH_RE.test(p)) routes.add(p);
    if (AUTH_PATH_RE.test(p)) auth.add(p);
    if (SECRET_PATH_RE.test(p)) secrets.add(p);
  }
  const sourceCount = new Map<string, number>();
  for (const f of findings) {
    if (f.category === 'taint-source') {
      if (f.ruleId === 'source.http-input') routes.add(f.filePath);
      if (f.ruleId === 'source.process-env') secrets.add(f.filePath);
      sourceCount.set(f.filePath, (sourceCount.get(f.filePath) ?? 0) + 1);
    }
    if (f.category === 'secret') secrets.add(f.filePath);
    if (f.category === 'auth') auth.add(f.filePath);
  }
  const cap = (s: Iterable<string>) => [...s].sort().slice(0, 100);
  return {
    entryPoints: entry.sort().slice(0, 50),
    routes: cap(routes),
    authBoundaries: cap(auth),
    secretTouchpoints: cap(secrets),
    taintSources: [...sourceCount.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100),
  };
}

export function toWireFinding(r: SecurityFindingRow): SecurityFindingWire {
  return {
    fingerprint: r.fingerprint,
    path: r.filePath,
    line: r.line,
    ruleId: r.ruleId,
    category: r.category,
    severity: r.severity,
    source: r.source,
    title: r.title,
    ...(r.evidence ? { evidence: r.evidence } : {}),
    status: r.status,
    ...(r.taskRef ? { taskRef: r.taskRef } : {}),
  };
}

/** Breadth-first reachable set from `start` over `adj`, bounded by hops + a cap. */
export function bfsReach(adj: Map<string, string[]>, start: string, maxHops: number): string[] {
  const seen = new Set<string>([start]);
  let frontier = [start];
  const out: string[] = [];
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const nb of adj.get(node) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        out.push(nb);
        next.push(nb);
        if (out.length >= 200) return out;
      }
    }
    frontier = next;
  }
  return out;
}

const SEVERITY_ORDER: SecuritySeverity[] = ['info', 'low', 'medium', 'high', 'critical'];
export function severityRank(s: SecuritySeverity): number {
  return SEVERITY_ORDER.indexOf(s);
}
export function maxSeverity(a: SecuritySeverity, b: SecuritySeverity): SecuritySeverity {
  return severityRank(b) > severityRank(a) ? b : a;
}
