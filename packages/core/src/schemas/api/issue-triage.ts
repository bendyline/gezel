import { z } from 'zod';
import {
  BoekwachterIssueSchema,
  FileReviewIssueSeveritySchema,
  IssueVerdictKindSchema,
  IssueVerdictReasonSchema,
} from '../file-review.js';

// ── issue triage: verdicts on BW issues ──────────────────────────────────────
// The person, a gezel, or an outside coding app checks a Boekwachter lead
// against the code and says what it is. Who said it comes from the caller's
// credential, never from these bodies. See docs/issue-triage.md.

const BwRefSchema = z.string().regex(/^BW-[1-9]\d*$/);

export const IssueVerdictInputSchema = z
  .object({
    ref: BwRefSchema,
    kind: IssueVerdictKindSchema,
    /** Only for `not_a_bug`; omitted reads as `incorrect`. */
    reason: IssueVerdictReasonSchema.optional(),
    /** The evidence: what was checked, ideally `file:line` or a test. */
    note: z.string().max(2000).optional(),
    duplicateOf: BwRefSchema.optional(),
  })
  .refine((v) => v.kind !== 'duplicate' || (v.duplicateOf && v.duplicateOf !== v.ref), {
    message: 'duplicate needs duplicateOf naming a different BW issue',
  })
  .refine((v) => v.reason === undefined || v.kind === 'not_a_bug', {
    message: 'reason applies only to not_a_bug',
  });
export type IssueVerdictInput = z.infer<typeof IssueVerdictInputSchema>;

/** Most calls carry one verdict; an import may carry up to 500. */
export const MAX_ISSUE_VERDICTS_PER_CALL = 500;
/** An outside app or a gezel reports in batches of at most this many. */
export const MAX_APP_ISSUE_VERDICTS_PER_CALL = 25;

export const ApplyIssueVerdictsRequestSchema = z.object({
  verdicts: z.array(IssueVerdictInputSchema).min(1).max(MAX_ISSUE_VERDICTS_PER_CALL),
});
export type ApplyIssueVerdictsRequest = z.infer<typeof ApplyIssueVerdictsRequestSchema>;

export const IssueVerdictResultSchema = z.object({
  ref: z.string(),
  outcome: z.enum(['applied', 'refused']),
  /** Plain words for the caller: what changed, or why nothing did. */
  message: z.string(),
  issue: BoekwachterIssueSchema.optional(),
});
export type IssueVerdictResult = z.infer<typeof IssueVerdictResultSchema>;

export const ApplyIssueVerdictsResponseSchema = z.object({
  results: z.array(IssueVerdictResultSchema),
  applied: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
});
export type ApplyIssueVerdictsResponse = z.infer<typeof ApplyIssueVerdictsResponseSchema>;

// ── the triage queue: which issues to hand an outside app next ───────────────

export const IssueHandoffRequestSchema = z.object({
  /** How many issues to hand over; batches are grouped by file. */
  limit: z.number().int().positive().max(50).optional(),
  severity: FileReviewIssueSeveritySchema.optional(),
  /** Only issues under this folder or file, relative to the project. */
  pathPrefix: z.string().max(500).optional(),
  /** Info-level leads are left out unless asked for: there are many and they are rarely worth a frontier model's time. */
  includeInfo: z.boolean().optional(),
  /** `fix` puts issues someone already confirmed first. */
  mode: z.enum(['triage', 'fix']).optional(),
});
export type IssueHandoffRequest = z.infer<typeof IssueHandoffRequestSchema>;

export const IssueHandoffItemSchema = z.object({
  ref: z.string(),
  severity: FileReviewIssueSeveritySchema,
  category: z.string(),
  message: z.string(),
  line: z.number().int().positive().optional(),
  /** The file changed since the review; the line is where it was. */
  stale: z.boolean(),
  /** An earlier verdict worth knowing: `confirmed` or `unsure`, with its note. */
  verdict: IssueVerdictKindSchema.optional(),
  verdictNote: z.string().optional(),
});
export type IssueHandoffItem = z.infer<typeof IssueHandoffItemSchema>;

export const IssueHandoffFileSchema = z.object({
  /** Relative to the project folder. */
  path: z.string(),
  issues: z.array(IssueHandoffItemSchema),
});
export type IssueHandoffFile = z.infer<typeof IssueHandoffFileSchema>;

export const IssueHandoffResponseSchema = z.object({
  files: z.array(IssueHandoffFileSchema),
  count: z.number().int().nonnegative(),
  /** Eligible issues left after this batch. */
  remaining: z.number().int().nonnegative(),
  /**
   * Issues in categories the verdicts say are almost never real, held back
   * (one is still sampled per batch). Counted in `remaining`.
   */
  lowConfidence: z.number().int().nonnegative().optional(),
  /**
   * Too few verdicts yet to know which leads tend to be real, so the batch
   * samples across severities and categories instead of taking the top.
   */
  firstBatch: z.boolean(),
  /** False until the project has an index to read issues from. */
  indexed: z.boolean(),
});
export type IssueHandoffResponse = z.infer<typeof IssueHandoffResponseSchema>;

// ── the handoff document ─────────────────────────────────────────────────────

export const IssueHandoffDocumentResponseSchema = z.object({
  markdown: z.string(),
  count: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});
export type IssueHandoffDocumentResponse = z.infer<typeof IssueHandoffDocumentResponseSchema>;

export const ImportIssueVerdictsRequestSchema = z.object({
  /** A filled-in handoff document. */
  markdown: z.string().min(1).max(2_000_000),
  /** The app the person says filled it in; recorded, never treated as the person. */
  declaredApp: z.string().max(60).optional(),
});
export type ImportIssueVerdictsRequest = z.infer<typeof ImportIssueVerdictsRequestSchema>;

export const ImportIssueVerdictsResponseSchema = ApplyIssueVerdictsResponseSchema.extend({
  /** Issues whose response was left empty or named no verdict Gezel knows. */
  skipped: z.array(z.string()),
});
export type ImportIssueVerdictsResponse = z.infer<typeof ImportIssueVerdictsResponseSchema>;

// ── how often the reviewer's leads are real ──────────────────────────────────

export const IssueVerdictTallySchema = z.object({
  decided: z.number().int().nonnegative(),
  actionable: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  wrong: z.number().int().nonnegative(),
});
export type IssueVerdictTally = z.infer<typeof IssueVerdictTallySchema>;

export const IssueVerdictStatsResponseSchema = z.object({
  overall: IssueVerdictTallySchema,
  categories: z.array(
    IssueVerdictTallySchema.extend({ category: z.string(), lowConfidence: z.boolean() }),
  ),
  models: z.array(IssueVerdictTallySchema.extend({ model: z.string(), category: z.string() })),
  apps: z.array(
    z.object({
      client: z.string(),
      decided: z.number().int().nonnegative(),
      dismissed: z.number().int().nonnegative(),
      /** Of its dismissals, how many the person reopened. */
      reopenedByPerson: z.number().int().nonnegative(),
    }),
  ),
});
export type IssueVerdictStatsResponse = z.infer<typeof IssueVerdictStatsResponseSchema>;
