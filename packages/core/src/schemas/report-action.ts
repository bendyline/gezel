import { z } from 'zod';

/**
 * Report actions — structured "follow-up action requests" embedded in
 * markdown report artifacts (night-shift reviews, audits, digests) as
 * ```gezel-action fenced YAML blocks. The report stays a readable
 * document everywhere; surfaces that understand the fence render each
 * block as a fireable card instead.
 *
 * Three kinds in v1:
 *   - `fire-craftbook`: run an existing craftbook with params
 *   - `create-task`:    delegate a bespoke one-off task ("fix this bug")
 *   - `apply-edits`:    apply a reviewed pack of file diffs, each diff a
 *                       SIDECAR artifact (`.diff` file) referenced by
 *                       path — never inlined in the YAML (triple-nested
 *                       escaping is a small-model failure mode)
 *
 * The fence-body parser lives in `markdown/report-actions.ts` (tolerant,
 * never throws); this file is the wire/lifecycle vocabulary. Everything
 * here is model-authored and therefore untrusted: nothing fires without
 * an authenticated user action, and execution surfaces re-validate.
 */

export const ReportActionKindSchema = z.enum(['fire-craftbook', 'create-task', 'apply-edits']);
export type ReportActionKind = z.infer<typeof ReportActionKindSchema>;

const commonFields = {
  /**
   * Author-supplied stable slug — keeps lifecycle state attached across
   * nightly report regenerations. Optional: the parser falls back to a
   * content hash (`a-<hash>`), which is stable only while the block's
   * body is byte-identical.
   */
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/i)
    .optional(),
  /** Short human label for the card ("Fix the unchecked null in parser.ts"). */
  title: z.string().min(1),
  /** One-or-two-sentence rationale shown under the title. */
  reason: z.string().optional(),
  /**
   * Target project. Defaults to the report's own project. Cross-project
   * targets are a primary case — the bundled oversight report lives in
   * `default` but recommends work in specific projects.
   */
  projectId: z.string().optional(),
};

export const FireCraftbookActionSchema = z.object({
  kind: z.literal('fire-craftbook'),
  ...commonFields,
  craftbookId: z.string().min(1),
  /** Invocation params for the craftbook's paramSchema (stringified values). */
  params: z.record(z.string(), z.string()).optional(),
});
export type FireCraftbookAction = z.infer<typeof FireCraftbookActionSchema>;

export const CreateTaskActionSchema = z.object({
  kind: z.literal('create-task'),
  ...commonFields,
  /** Full work instruction for the bespoke task's single step. */
  prompt: z.string().min(1),
  /** Role to recruit for the work (ensure_gezel jobTitle). Default: software developer. */
  role: z.string().optional(),
});
export type CreateTaskAction = z.infer<typeof CreateTaskActionSchema>;

export const ApplyEditsActionSchema = z.object({
  kind: z.literal('apply-edits'),
  ...commonFields,
  edits: z
    .array(
      z.object({
        /** Workspace-relative target file in the TARGET project. */
        path: z.string().min(1),
        /** Artifacts-relative sidecar `.diff` path in the REPORT's project. */
        diffArtifact: z.string().min(1),
      }),
    )
    .min(1),
});
export type ApplyEditsAction = z.infer<typeof ApplyEditsActionSchema>;

export const ReportActionSchema = z.discriminatedUnion('kind', [
  FireCraftbookActionSchema,
  CreateTaskActionSchema,
  ApplyEditsActionSchema,
]);
export type ReportAction = z.infer<typeof ReportActionSchema>;

/** A parsed action with its identity resolved (author slug or content hash). */
export type ParsedReportAction = ReportAction & {
  id: string;
  /** FNV-1a hash of the trimmed fence body — detects regeneration drift. */
  contentHash: string;
};

/* ─── Lifecycle records ────────────────────────────────────────────── */

export const ReportActionStateSchema = z.enum([
  'suggested',
  'fired',
  'applied',
  'failed',
  'dismissed',
]);
export type ReportActionState = z.infer<typeof ReportActionStateSchema>;

/**
 * Durable per-project record for one action the user interacted with.
 * Virtual until first interaction: a regenerated report costs nothing.
 * Stored in `projects/{id}/report-actions.json` by the service's
 * ReportActionManager.
 */
export const ReportActionRecordSchema = z.object({
  actionId: z.string(),
  /** Artifacts-relative path of the report the action came from. */
  reportPath: z.string(),
  kind: ReportActionKindSchema,
  contentHash: z.string(),
  firstSeenAt: z.string(),
  state: ReportActionStateSchema,
  /** Task materialized by fire-craftbook / create-task. */
  taskRef: z.string().optional(),
  firedAt: z.string().optional(),
  /** Stamped when the fired task settles. */
  settledAt: z.string().optional(),
  outcome: z.enum(['complete', 'canceled']).optional(),
  /** apply-edits per-file results. */
  results: z
    .array(
      z.object({
        path: z.string(),
        ok: z.boolean(),
        error: z.string().optional(),
      }),
    )
    .optional(),
});
export type ReportActionRecord = z.infer<typeof ReportActionRecordSchema>;

/* ─── Wire shapes ─────────────────────────────────────────────────── */

export const ReportActionParseIssueSchema = z.object({
  /** Zero-based index among the report's gezel-action fences. */
  index: z.number().int(),
  message: z.string(),
  /** Raw fence body, for the "unreadable action block" card. */
  raw: z.string(),
});
export type ReportActionParseIssue = z.infer<typeof ReportActionParseIssueSchema>;

export const ReportActionViewSchema = z.object({
  action: ReportActionSchema,
  id: z.string(),
  contentHash: z.string(),
  state: ReportActionStateSchema,
  taskRef: z.string().optional(),
  firedAt: z.string().optional(),
  settledAt: z.string().optional(),
  outcome: z.enum(['complete', 'canceled']).optional(),
  results: z
    .array(z.object({ path: z.string(), ok: z.boolean(), error: z.string().optional() }))
    .optional(),
  /** The stored record predates a changed block body (report regenerated). */
  contentChanged: z.boolean().optional(),
});
export type ReportActionView = z.infer<typeof ReportActionViewSchema>;

export const ReportActionsResponseSchema = z.object({
  actions: z.array(ReportActionViewSchema),
  issues: z.array(ReportActionParseIssueSchema),
  /** Records whose action vanished from the regenerated report. */
  stale: z.array(ReportActionRecordSchema),
});
export type ReportActionsResponse = z.infer<typeof ReportActionsResponseSchema>;

export const FireReportActionRequestSchema = z.object({
  /** Artifacts-relative report path. */
  path: z.string().min(1),
  actionId: z.string().min(1),
  /** apply-edits: none. fire-craftbook: overrides the block's params. */
  params: z.record(z.string(), z.string()).optional(),
});
export type FireReportActionRequest = z.infer<typeof FireReportActionRequestSchema>;

export const FireReportActionResponseSchema = z.object({
  record: ReportActionRecordSchema,
  /** Set for fire-craftbook / create-task. */
  taskRef: z.string().optional(),
});
export type FireReportActionResponse = z.infer<typeof FireReportActionResponseSchema>;

export const DismissReportActionRequestSchema = z.object({
  path: z.string().min(1),
  actionId: z.string().min(1),
});
export type DismissReportActionRequest = z.infer<typeof DismissReportActionRequestSchema>;
