import { z } from 'zod';
import { RelevanceThresholdsSchema } from './relevance-model.js';
import { RetrievalModeSchema, RetrievalSourceSchema } from './retrieval.js';

/**
 * Why a retrieval candidate was kept or dropped. One reason per candidate,
 * so "every arm scored under the floor", "grounding rejected the keyword
 * hit", and "the relevance model judged it off-topic" stay distinguishable
 * in telemetry and in the retrieval evals.
 */
export const RETRIEVAL_DECISION_REASONS = [
  'kept',
  /** The relevance model scored it below the surface's cutoff. */
  'relevance-model',
  /** Below the per-kind injection floor (rank-derived relevance). */
  'floor',
  /** A keyword hit whose injected text names no term of the query. */
  'grounding',
  /** Reference list: title/path/snippet names no subject term. */
  'lexical',
  /** Beyond the depth the surface fetches for unscored candidates. */
  'depth',
  /** A better-scored hit on the same document was kept instead. */
  'duplicate-path',
  /** Inside a folder another task of this project declared. */
  'other-task',
  /** Already on the task's launch reference list. */
  'reference-list',
  /** A corpus the resolved policy does not include, or no citation handle. */
  'source-policy',
  /** Past the per-mode cap on knowledge-catalog chunks. */
  'knowledge-cap',
  /** Hydration produced no text to inject. */
  'no-excerpt',
  /** Did not fit the token budget. */
  'budget',
  /** Reference list already full. */
  'reference-limit',
] as const;
export const RetrievalDecisionReasonSchema = z.enum(RETRIEVAL_DECISION_REASONS);
export type RetrievalDecisionReason = z.infer<typeof RetrievalDecisionReasonSchema>;

export const RETRIEVAL_TRACE_SURFACES = ['turn', 'references', 'search'] as const;
export const RetrievalTraceSurfaceSchema = z.enum(RETRIEVAL_TRACE_SURFACES);
export type RetrievalTraceSurface = z.infer<typeof RetrievalTraceSurfaceSchema>;

/**
 * One candidate's path through a retrieval decision. Citation coordinates
 * and scores only — never snippet or excerpt text (docs/project-retrieval.md,
 * "Trust, privacy, and audit").
 */
export const RetrievalTraceCandidateSchema = z.object({
  id: z.string(),
  /** Stable per-document key — see `retrievalDocKey`. */
  docKey: z.string(),
  source: z.string().optional(),
  kind: z.string(),
  arm: z.string().optional(),
  /** 0-based position in the fused, merged search order. */
  fusedRank: z.number().int().nonnegative(),
  /** Relevance the search layer assigned before any relevance model. */
  fusedRelevance: z.number().optional(),
  /** The relevance model's activated score, when it judged this candidate. */
  modelScore: z.number().optional(),
  kept: z.boolean(),
  reason: RetrievalDecisionReasonSchema,
});
export type RetrievalTraceCandidate = z.infer<typeof RetrievalTraceCandidateSchema>;

/** What the relevance model did on one retrieval call. Counts and timing only. */
export const RetrievalRelevanceSummarySchema = z.object({
  modelId: z.string(),
  /** scored | partial | timeout | cold | unavailable | disabled */
  status: z.string(),
  /** Calibrated thresholds let the model drop; without them it only reorders. */
  calibrated: z.boolean(),
  scored: z.number().int().nonnegative(),
  hidden: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
});
export type RetrievalRelevanceSummary = z.infer<typeof RetrievalRelevanceSummarySchema>;

export const RetrievalDecisionTraceSchema = z.object({
  surface: RetrievalTraceSurfaceSchema,
  queryHash: z.string(),
  candidates: z.array(RetrievalTraceCandidateSchema),
  /** Candidate count per reason, `kept` included. */
  counts: z.record(z.string(), z.number().int().nonnegative()),
  /** The search itself missed its budget (reference list), so nothing was judged. */
  timedOut: z.boolean().optional(),
  /** A source scope timed out, so the candidates under-represent the corpus. */
  sourcesIncomplete: z.boolean().optional(),
  relevanceModel: RetrievalRelevanceSummarySchema.optional(),
});
export type RetrievalDecisionTrace = z.infer<typeof RetrievalDecisionTraceSchema>;

/**
 * The per-document identity of a search hit, shared by the runtime trace and
 * the retrieval evals' relevance labels. A knowledge URI's `#chunk=` fragment
 * names a passage, not a different document, so it is dropped.
 */
export function retrievalDocKey(result: {
  id: string;
  retrievalSource?: string;
  source?: string;
  projectId?: string;
  path?: string;
  uri?: string;
}): string {
  const source = result.retrievalSource ?? result.source;
  if (result.uri) return result.uri.replace(/#.*$/, '');
  if (source === 'shared' && result.path) return `shared:${result.path}`;
  if ((source === 'workspace' || source === 'artifacts') && result.path) {
    return `${source}:${result.projectId ?? ''}:${result.path}`;
  }
  return result.id;
}

/**
 * A preview's relevance-model arm, in place of the resolved setting — how the
 * retrieval bench compares off, uncalibrated, and candidate thresholds on
 * one daemon. `thresholds: null` scores and reorders without dropping.
 */
export const RelevanceModelOverrideSchema = z.object({
  enabled: z.boolean(),
  modelId: z.string().optional(),
  thresholds: RelevanceThresholdsSchema.nullable().optional(),
  budgetMs: z.number().int().positive().max(60_000).optional(),
});
export type RelevanceModelOverride = z.infer<typeof RelevanceModelOverrideSchema>;

/**
 * `POST /api/projects/:id/retrieval/preview` — run a retrieval surface's real
 * decision code without side effects (no history, no session state) and
 * return what it would keep, with one decision per candidate. The retrieval
 * evals' way into the injection decision; never a session-token route.
 */
export const RetrievalPreviewRequestSchema = z.object({
  surface: RetrievalTraceSurfaceSchema,
  /**
   * turn: the user text of the turn; references: the launch subject;
   * search: the search query.
   */
  query: z.string().min(1).max(4_000),
  gezelId: z.string().optional(),
  /** turn: judge as this task step's turn (its subject, folders, references). */
  taskRef: z.string().optional(),
  stepId: z.string().optional(),
  messageOrigin: z
    .enum(['direct-user', 'question-answer', 'cross-gezel', 'background-nudge', 'system'])
    .optional(),
  /** turn: override the resolved policy for this preview only. */
  mode: RetrievalModeSchema.optional(),
  maxTokens: z.number().int().min(0).max(16_000).optional(),
  sources: z.array(RetrievalSourceSchema).min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  availableToolNames: z.array(z.string()).optional(),
  /** references: the book name whose words are not subject terms. */
  craftbookName: z.string().optional(),
  /** search: result depth. */
  maxResults: z.number().int().positive().max(100).optional(),
  /** Load the embedding models first, so the preview measures the warm path. */
  warm: z.boolean().optional(),
  /** Judge with this relevance-model arm instead of the resolved setting. */
  relevanceModel: RelevanceModelOverrideSchema.optional(),
  /** Include the rendered prompt / reference snippets (text) in the response. */
  includeText: z.boolean().optional(),
});
export type RetrievalPreviewRequest = z.infer<typeof RetrievalPreviewRequestSchema>;

export interface RetrievalPreviewKept {
  id: string;
  docKey: string;
  source?: string;
  kind: string;
  title?: string;
  path?: string;
  uri?: string;
  catalogId?: string;
  relevance?: number;
  tier?: 'strong' | 'weak';
}

export interface RetrievalPreviewResponse {
  surface: RetrievalTraceSurface;
  policy?: {
    mode: string;
    maxTokens: number;
    sources: readonly string[];
    inheritedFrom: string;
  };
  trace: RetrievalDecisionTrace | null;
  kept: RetrievalPreviewKept[];
  estimatedTokens?: number;
  injectedBytes?: number;
  /** Only with `includeText`. */
  prompt?: string;
  timings: { totalMs: number };
  arms?: Array<{
    arm: string;
    scope?: string;
    ms: number;
    hits: number;
    timedOut: boolean;
    failed: boolean;
  }>;
  embedder: { status: string; reason?: string };
  relevanceModel?: RetrievalRelevanceSummary;
}
