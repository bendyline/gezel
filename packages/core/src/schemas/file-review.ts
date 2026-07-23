import { z } from 'zod';

/**
 * Boekwachter file reviews — the per-file "cliffs notes + health" artifact the
 * review pass produces on top of the search-oriented enrichment summary:
 * type-specific notes (1 sentence to ~3 paragraphs of markdown), a structured
 * list of issues the model saw, and a 1-10 health score judged against a
 * per-file-kind rubric. Stored hash-keyed in the per-project index db
 * (`file_reviews`); served on outline-file/file-context and the `file_review`
 * / `list_file_issues` tools.
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
  reviewedAt: z.string().nullable(),
});
export type FileReviewWire = z.infer<typeof FileReviewWireSchema>;
