import { z } from 'zod';

/**
 * The report `index.ensureFresh` (script SDK) returns and craftbook hooks
 * persist as a launch-time freshness snapshot. "Up to date" is not one
 * boolean for a project index — the static scan, the local embed tier, and
 * the roster-gated AI tiers (summaries, shadows, reviews) each have their
 * own drain state, and on a project with no Boekwachter the AI counts can
 * NEVER reach zero. The report therefore separates what IS current from
 * what CAN become current (`achievable`), so a review that consumes it can
 * state its coverage honestly instead of hanging on an unreachable drain.
 */

export const IndexReadinessSearchSchema = z.object({
  /** Semantic search usable now (embed tier drained + vectors healthy). */
  ready: z.boolean(),
  eligible: z.number().optional(),
  embedded: z.number().optional(),
  /** Files still waiting on the always-on local embed tier. */
  pendingEmbedOnly: z.number().optional(),
  embedModel: z.string().optional(),
  vectorsAvailable: z.boolean().optional(),
});

export const IndexReadinessReviewsSchema = z.object({
  eligible: z.number(),
  reviewed: z.number(),
  stale: z.number(),
  pending: z.number(),
});

export const IndexReadinessAiTierSchema = z.object({
  /** A Boekwachter gezel is on the project crew (the AI-tier opt-in). */
  staffed: z.boolean(),
  /** The install-wide indexing job is paused. */
  paused: z.boolean(),
  /**
   * The AI tiers can make progress at all: indexing enabled, staffed, not
   * paused. When false, the pending counts below are permanent, not a queue.
   */
  achievable: z.boolean(),
  summariesEligible: z.number().optional(),
  summarized: z.number().optional(),
  summariesPending: z.number().optional(),
  shadowsPending: z.number().optional(),
  /** Files dropped after repeated enrichment failures (won't retry). */
  skipped: z.number().optional(),
  /** Per-file AI review (Boekwachter issue) coverage. */
  reviews: IndexReadinessReviewsSchema.optional(),
});

export const IndexReadinessWaitSchema = z.object({
  /** Awake-time wait budget the ensure call ran under (ms). */
  budgetMs: z.number(),
  /** Awake time actually spent waiting on index work (ms). */
  waitedMs: z.number(),
  /** Every achievable tier drained inside the budget. */
  drained: z.boolean(),
  /** A catch-up drive was still running when the call returned. */
  driveStillRunning: z.boolean(),
});

export const IndexReadinessReportSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  generatedAt: z.string(),
  indexingEnabled: z.boolean(),
  /** Structural index state after the ensure pass. */
  staticState: z.enum(['fresh', 'stale', 'indexing', 'never', 'disabled']),
  fileCount: z.number().optional(),
  scannedAt: z.string().optional(),
  search: IndexReadinessSearchSchema,
  aiTier: IndexReadinessAiTierSchema,
  wait: IndexReadinessWaitSchema,
  /**
   * Human/model-readable caveats: unstaffed crew, paused job, expired
   * budget with work continuing, indexing disabled. Empty = fully fresh.
   */
  notes: z.array(z.string()),
});
export type IndexReadinessReport = z.infer<typeof IndexReadinessReportSchema>;
export type IndexReadinessSearch = z.infer<typeof IndexReadinessSearchSchema>;
export type IndexReadinessAiTier = z.infer<typeof IndexReadinessAiTierSchema>;
