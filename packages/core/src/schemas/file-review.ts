import { z } from 'zod';

/**
 * Boekwachter file reviews — the per-file "cliffs notes + health" artifact the
 * review pass produces on top of the search-oriented enrichment summary:
 * type-specific notes (1 sentence to ~3 paragraphs of markdown), a structured
 * list of issues the model saw, and a 1-10 health score judged against a
 * per-file-kind rubric. Raw review snapshots are stored hash-keyed in the
 * per-project index db (`file_reviews`). Issues are additionally materialized
 * into a durable project-local lifecycle registry so an edit cannot erase the
 * observation; consumers receive an explicit stale bit when its old anchor no
 * longer matches the current file hash.
 */

/**
 * Issue severity. Deliberately a SEPARATE vocabulary from security-finding
 * severities (`critical..info`): quality issues are not vulnerabilities and
 * the surfaces must not imply otherwise.
 */
export const FileReviewIssueSeveritySchema = z.enum(['info', 'minor', 'major']);
export type FileReviewIssueSeverity = z.infer<typeof FileReviewIssueSeveritySchema>;

export const FileReviewIssueSchema = z.object({
  severity: FileReviewIssueSeveritySchema,
  /** Coarse class, e.g. `bug`, `smell`, `error-handling`, `grammar`, `clarity`. */
  category: z.string().min(1).max(40),
  /** Specific, self-contained description of the problem. */
  message: z.string().min(1).max(300),
  /** 1-based line the issue anchors to; advisory — omit when unknown. */
  line: z.number().int().positive().optional(),
});
export type FileReviewIssue = z.infer<typeof FileReviewIssueSchema>;

/**
 * Durable lifecycle for a Boekwachter lead. Read/unread is deliberately kept
 * orthogonal to this state: opening an issue must not make it resolved, and a
 * resolved issue may still be marked unread when someone wants to revisit it.
 */
export const BoekwachterIssueStatusSchema = z.enum([
  'open',
  'in_progress',
  'resolved',
  'dismissed',
]);
export type BoekwachterIssueStatus = z.infer<typeof BoekwachterIssueStatusSchema>;

export const BoekwachterIssueDismissalReasonSchema = z.enum([
  'not_an_issue',
  'duplicate',
  'wont_fix',
]);
export type BoekwachterIssueDismissalReason = z.infer<typeof BoekwachterIssueDismissalReasonSchema>;

/**
 * What someone concluded about a BW issue after checking it against the code.
 * `nit` (true but not worth fixing) is separate from `not_a_bug` on purpose:
 * frontier models are picky about low-grade leads, and calling a valid minor
 * lead "not a bug" must not count against the reviewer that raised it.
 * See docs/issue-triage.md.
 */
export const ISSUE_VERDICT_KINDS = [
  'fixed',
  'confirmed',
  'not_a_bug',
  'nit',
  'wont_fix',
  'duplicate',
  'unsure',
] as const;
export const IssueVerdictKindSchema = z.enum(ISSUE_VERDICT_KINDS);
export type IssueVerdictKind = z.infer<typeof IssueVerdictKindSchema>;

/** Why a lead is not a bug: wrong about the code, prevented elsewhere, or deliberate. */
export const IssueVerdictReasonSchema = z.enum(['incorrect', 'handled_elsewhere', 'intended']);
export type IssueVerdictReason = z.infer<typeof IssueVerdictReasonSchema>;

/**
 * Entries gezel writes into the verdict log itself; never accepted from a
 * caller. `reopened` is the person overriding an earlier verdict.
 */
export const IssueVerdictSystemKindSchema = z.enum(['recurred', 'echo', 'superseded', 'reopened']);
export const IssueVerdictLogKindSchema = z.union([
  IssueVerdictKindSchema,
  IssueVerdictSystemKindSchema,
]);
export type IssueVerdictLogKind = z.infer<typeof IssueVerdictLogKindSchema>;

/**
 * Who reached a verdict. Always derived from the caller's credential, never
 * from a request body. An imported document is not the person, whatever app
 * filled it in.
 */
export const IssueVerdictActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person') }),
  z.object({ kind: z.literal('app'), client: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('gezel'), gezelId: z.string().min(1) }),
  z.object({ kind: z.literal('import'), declaredApp: z.string().max(60).optional() }),
  z.object({ kind: z.literal('system') }),
]);
export type IssueVerdictActor = z.infer<typeof IssueVerdictActorSchema>;

/** The latest verdict, as carried on the issue itself. The full history is the verdict log. */
export const IssueVerdictSummarySchema = z.object({
  kind: IssueVerdictLogKindSchema,
  reason: IssueVerdictReasonSchema.optional(),
  by: IssueVerdictActorSchema,
  at: z.string(),
  /** First 300 characters of the note. */
  note: z.string().max(300).optional(),
  duplicateOf: z.string().optional(),
  /** "Fixed" while the file was unchanged since the review: gezel could not confirm it. */
  unverified: z.boolean().optional(),
});
export type IssueVerdictSummary = z.infer<typeof IssueVerdictSummarySchema>;

/**
 * One line of `boekwachter-verdicts.jsonl`: append-only, the issue's history
 * and the calibration dataset. Snapshots the lead as it read when judged, so
 * the log stays meaningful after the record changes.
 */
export const IssueVerdictEntrySchema = IssueVerdictSummarySchema.extend({
  id: z.string().min(1),
  issueId: z.string().min(1),
  fingerprint: z.string().min(1),
  ref: z.string(),
  path: z.string(),
  note: z.string().max(2000).optional(),
  /** The file's hash when judged, read from the file itself; null when unreadable. */
  fileHash: z.string().nullable().optional(),
  /** The hash the lead was last reported on; a later review of this exact content means a revert. */
  preFixHash: z.string().optional(),
  reviewModel: z.string().optional(),
  severity: FileReviewIssueSeveritySchema,
  category: z.string(),
  message: z.string(),
  /** For `echo`/`superseded`: the other issue involved. */
  relatedRef: z.string().optional(),
});
export type IssueVerdictEntry = z.infer<typeof IssueVerdictEntrySchema>;

/**
 * A review issue after it has been materialized into the project-local
 * lifecycle registry. `stale` means the current file hash differs from the
 * hash whose review last reported the issue; the old line is retained as
 * evidence, but consumers must label it as a previous anchor.
 */
export const BoekwachterIssueSchema = FileReviewIssueSchema.extend({
  /** Small project-scoped reference intended for people and prompts. */
  ref: z.string().regex(/^BW-[1-9]\d*$/),
  /** Collision-resistant internal identity; never use the display ref as a map key. */
  id: z.string().min(1),
  /** Deterministic identity of the observed lead, used to reconcile repeat reviews. */
  fingerprint: z.string().min(1),
  path: z.string().min(1),
  status: BoekwachterIssueStatusSchema,
  seen: z.boolean(),
  stale: z.boolean(),
  taskRef: z.string().optional(),
  dismissalReason: BoekwachterIssueDismissalReasonSchema.optional(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  lastCheckedAt: z.string().optional(),
  seenAt: z.string().optional(),
  resolvedAt: z.string().optional(),
  dismissedAt: z.string().optional(),
  /** Dropped by an older client that meets a verdict kind it doesn't know. */
  latestVerdict: IssueVerdictSummarySchema.optional().catch(undefined),
  /** The model whose review last reported this lead. */
  reviewModel: z.string().optional(),
  /** An earlier issue this one repeats in other words. */
  echoOf: z.string().optional(),
  /** A later rewording of this lead replaced it. */
  supersededBy: z.string().optional(),
  /** An outside app is checking this issue until `until`; the night shift leaves it alone. */
  handoff: z.object({ client: z.string(), until: z.string() }).optional().catch(undefined),
  /**
   * Its category is almost never worth fixing, on the project's verdicts.
   * Left out of counts and badges; still listed, never for a major issue.
   */
  lowConfidence: z.boolean().optional(),
});
export type BoekwachterIssue = z.infer<typeof BoekwachterIssueSchema>;

/**
 * The strict LLM-reply contract (snake keys — exactly what the review prompt
 * asks the model to emit). Parsed tolerantly then validated against this.
 */
export const FileReviewReplySchema = z.object({
  notes_md: z.string().min(1),
  issues: z.array(FileReviewIssueSchema),
  health: z.number().int().min(1).max(10),
  health_reason: z.string().min(1),
});
export type FileReviewReply = z.infer<typeof FileReviewReplySchema>;

/** Wire shape served on file-context / outline-file / file_review (camelCase). */
export const FileReviewWireSchema = z.object({
  notesMd: z.string(),
  issues: z.array(FileReviewIssueSchema),
  health: z.number().int().min(1).max(10),
  healthReason: z.string(),
  /** Model that produced the review, null when unrecorded. */
  model: z.string().nullable(),
  /** Provider the model ran on; null on rows written before provenance landed. */
  provider: z.string().nullable().optional(),
  /** The Boekwachter gezel whose persona ran the review, when one was on the roster. */
  gezelId: z.string().nullable().optional(),
  gezelName: z.string().nullable().optional(),
  /** Gezel app version that wrote the row (release-stamped; `0.0.0` in dev). */
  appVersion: z.string().nullable().optional(),
  reviewedAt: z.string().nullable(),
});
export type FileReviewWire = z.infer<typeof FileReviewWireSchema>;

/**
 * One-line provenance rendering shared by the MCP tools and the UI review
 * card: `Reviewed by <model> (<provider>) · <gezel> · gezel <version> · <date>`.
 * Null segments drop out; null when even the model is unrecorded.
 */
export function formatReviewProvenance(
  r: Pick<FileReviewWire, 'model' | 'reviewedAt'> &
    Partial<Pick<FileReviewWire, 'provider' | 'gezelName' | 'appVersion'>>,
): string | null {
  if (!r.model) return null;
  const parts = [`Reviewed by ${r.model}${r.provider ? ` (${r.provider})` : ''}`];
  if (r.gezelName) parts.push(r.gezelName);
  if (r.appVersion) parts.push(r.appVersion === '0.0.0' ? 'gezel dev' : `gezel ${r.appVersion}`);
  if (r.reviewedAt) parts.push(r.reviewedAt.slice(0, 10));
  return parts.join(' · ');
}
