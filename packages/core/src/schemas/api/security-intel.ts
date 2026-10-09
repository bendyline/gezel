import { z } from 'zod';
import { TaskRefSchema } from '../task.js';

// ── security-intel (static security analysis over the index) ─────────────────
// The deterministic built-in scan runs in the index hot path; the whole-repo
// `security_scan` refresh (reachability + opportunistic OSS tools) is on-demand.
// Every finding carries a real file + 1-based line so the model's next move is a
// precise read — same convention as code-intel.

export const SecuritySeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type SecuritySeverityWire = z.infer<typeof SecuritySeveritySchema>;

export const SecuritySourceSchema = z.enum(['builtin', 'semgrep', 'osv', 'gitleaks']);
export const SecurityFindingStatusSchema = z.enum(['open', 'in_progress', 'resolved']);
export type SecurityFindingStatus = z.infer<typeof SecurityFindingStatusSchema>;

export const SecurityFindingSchema = z.object({
  /** Stable identity across re-scans; used for lifecycle actions. */
  fingerprint: z.string().min(1),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  ruleId: z.string(),
  category: z.string(),
  severity: SecuritySeveritySchema,
  source: SecuritySourceSchema,
  title: z.string(),
  evidence: z.string().optional(),
  status: SecurityFindingStatusSchema,
  /** Task currently handling this finding, when delegated to a gezel. */
  taskRef: TaskRefSchema.optional(),
});
export type SecurityFindingWire = z.infer<typeof SecurityFindingSchema>;

const FindingCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  bySeverity: z.record(z.string(), z.number().int().nonnegative()),
  byCategory: z.record(z.string(), z.number().int().nonnegative()),
  bySource: z.record(z.string(), z.number().int().nonnegative()),
});

export const SecurityScanRequestSchema = z.object({
  /** Run opportunistic OSS tools (semgrep/osv-scanner/gitleaks) when present. Default true. */
  useExternalTools: z.boolean().optional(),
});
export type SecurityScanRequest = z.infer<typeof SecurityScanRequestSchema>;

const SecurityToolsAvailableSchema = z.object({
  semgrep: z.boolean(),
  osvScanner: z.boolean(),
  gitleaks: z.boolean(),
  npm: z.boolean(),
});

/** How the last dependency-advisory (SCA) measurement actually happened —
 *  the answer to "did we look and find nothing, or never look at all?". */
export const ScaProvenanceSchema = z.object({
  /** SCA tool attempted, or null when none is installed. A string (not an
   *  enum) so future engines don't require a wire change. */
  engine: z.string().nullable(),
  /** True only when the tool produced a real scan result — an advisory count
   *  without this is not a measurement. */
  measured: z.boolean(),
  /** Lockfiles present in the workspace, so a reader can judge coverage
   *  (npm audit reads only npm lockfiles; osv-scanner reads most). */
  lockfiles: z.array(z.string()),
});

export const SecurityScanProvenanceSchema = z.object({
  scannedAt: z.string(),
  engines: z.array(z.string()),
  toolsAvailable: SecurityToolsAvailableSchema,
  sca: ScaProvenanceSchema,
});
export type SecurityScanProvenance = z.infer<typeof SecurityScanProvenanceSchema>;

export const SecurityScanResponseSchema = z.object({
  ran: z.boolean(),
  engines: z.array(z.string()),
  toolsAvailable: SecurityToolsAvailableSchema,
  findingCounts: FindingCountsSchema,
  dependencies: z.number().int().nonnegative(),
  advisories: z.number().int().nonnegative(),
  sca: ScaProvenanceSchema.optional(),
});
export type SecurityScanResponse = z.infer<typeof SecurityScanResponseSchema>;

export const ScanFindingsRequestSchema = z.object({
  severity: SecuritySeveritySchema.optional(),
  category: z.string().optional(),
  path: z.string().optional(),
  source: SecuritySourceSchema.optional(),
  maxResults: z.number().int().positive().max(1000).optional(),
});
export type ScanFindingsRequest = z.infer<typeof ScanFindingsRequestSchema>;

export const ScanFindingsResponseSchema = z.object({
  findings: z.array(SecurityFindingSchema),
  counts: FindingCountsSchema,
  truncated: z.boolean(),
  indexed: z.boolean(),
});
export type ScanFindingsResponse = z.infer<typeof ScanFindingsResponseSchema>;

export const ResolveSecurityFindingRequestSchema = z.object({
  fingerprint: z.string().min(1),
});
export type ResolveSecurityFindingRequest = z.infer<typeof ResolveSecurityFindingRequestSchema>;

export const ResolveSecurityFindingResponseSchema = z.object({
  resolved: z.boolean(),
});
export type ResolveSecurityFindingResponse = z.infer<typeof ResolveSecurityFindingResponseSchema>;

export const DelegateSecurityFindingRequestSchema = z.object({
  fingerprint: z.string().min(1),
});
export type DelegateSecurityFindingRequest = z.infer<typeof DelegateSecurityFindingRequestSchema>;

export const DelegateSecurityFindingResponseSchema = z.object({
  finding: SecurityFindingSchema,
  taskRef: TaskRefSchema,
  gezelId: z.string(),
  gezelName: z.string(),
  enqueued: z.boolean(),
});
export type DelegateSecurityFindingResponse = z.infer<typeof DelegateSecurityFindingResponseSchema>;

const AttackSurfaceSchema = z.object({
  entryPoints: z.array(z.string()),
  routes: z.array(z.string()),
  authBoundaries: z.array(z.string()),
  secretTouchpoints: z.array(z.string()),
  taintSources: z.array(z.object({ path: z.string(), count: z.number().int().positive() })),
});

export const MapAttackSurfaceResponseSchema = AttackSurfaceSchema.extend({
  root: z.string(),
  indexed: z.boolean(),
});
export type MapAttackSurfaceResponse = z.infer<typeof MapAttackSurfaceResponseSchema>;

export const SecurityDependencySchema = z.object({
  name: z.string(),
  ecosystem: z.string(),
  version: z.string().nullable(),
  direct: z.boolean(),
  advisoryIds: z.array(z.string()),
  maxSeverity: SecuritySeveritySchema.nullable(),
  license: z.string().nullable(),
});
export type SecurityDependency = z.infer<typeof SecurityDependencySchema>;

export const ListDependenciesResponseSchema = z.object({
  dependencies: z.array(SecurityDependencySchema),
  total: z.number().int().nonnegative(),
  withAdvisories: z.number().int().nonnegative(),
  /** false until `security_scan` has populated the inventory. */
  scanned: z.boolean(),
  /** Absent on pre-provenance databases; re-running security_scan sets it. */
  provenance: SecurityScanProvenanceSchema.optional(),
});
export type ListDependenciesResponse = z.infer<typeof ListDependenciesResponseSchema>;

export const SecurityOverviewResponseSchema = z.object({
  indexed: z.boolean(),
  /** true once security_scan has run (dependency inventory / tool findings present). */
  scanned: z.boolean(),
  findings: FindingCountsSchema,
  attackSurface: z.object({
    entryPoints: z.number().int().nonnegative(),
    routes: z.number().int().nonnegative(),
    authBoundaries: z.number().int().nonnegative(),
    secretTouchpoints: z.number().int().nonnegative(),
    taintSources: z.number().int().nonnegative(),
  }),
  dependencies: z.object({
    total: z.number().int().nonnegative(),
    withAdvisories: z.number().int().nonnegative(),
  }),
  /** Categories recurring across many files — candidate systemic themes to investigate. */
  systemicCandidates: z.array(
    z.object({
      category: z.string(),
      fileCount: z.number().int().positive(),
      findingCount: z.number().int().positive(),
      severity: SecuritySeveritySchema,
    }),
  ),
  /** Absent on pre-provenance databases; re-running security_scan sets it. */
  provenance: SecurityScanProvenanceSchema.optional(),
});
export type SecurityOverviewResponse = z.infer<typeof SecurityOverviewResponseSchema>;

export const TraceTaintRequestSchema = z.object({
  /** Workspace-relative file to trace reachability around. */
  file: z.string().min(1),
  /** Import-graph hops to walk each direction. Default 3. */
  maxHops: z.number().int().positive().max(8).optional(),
});
export type TraceTaintRequest = z.infer<typeof TraceTaintRequestSchema>;

export const TraceTaintResponseSchema = z.object({
  file: z.string(),
  found: z.boolean(),
  /** Files that transitively import `file` (its blast radius / upstream callers). */
  upstream: z.array(z.string()),
  /** Files `file` transitively imports (downstream). */
  downstream: z.array(z.string()),
  /** Taint-source findings in `file` + upstream. */
  taintSources: z.array(SecurityFindingSchema),
  /** Sink findings in `file` + downstream. */
  sinks: z.array(SecurityFindingSchema),
  /** Honest description of what this reachability is (import-graph proximity, not precise dataflow). */
  note: z.string(),
});
export type TraceTaintResponse = z.infer<typeof TraceTaintResponseSchema>;
