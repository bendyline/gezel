import { z } from 'zod';

/**
 * How much indexed context Gezel should proactively place on a model turn.
 *
 * `off` keeps the model-facing search tool available but injects nothing.
 * The remaining modes are presets; `maxTokens` is an optional hard override
 * for operators and craftbook authors who need a more exact budget.
 */
export const RETRIEVAL_MODES = ['off', 'lean', 'balanced', 'deep'] as const;
export const RetrievalModeSchema = z.enum(RETRIEVAL_MODES);
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;

/** Corpora understood by both proactive retrieval and the generic search tool. */
export const RETRIEVAL_SOURCES = [
  'workspace',
  'artifacts',
  'project-memory',
  'gezel-memory',
  'shared',
] as const;
export const RetrievalSourceSchema = z.enum(RETRIEVAL_SOURCES);
export type RetrievalSource = z.infer<typeof RetrievalSourceSchema>;

export const RetrievalPolicySchema = z.object({
  mode: RetrievalModeSchema,
  /** Hard prompt budget after the mode preset and context-window clamp. */
  maxTokens: z.number().int().min(0).max(16_000).optional(),
  /** Absent means every corpus appropriate to the current session. */
  sources: z.array(RetrievalSourceSchema).min(1).optional(),
});
export type RetrievalPolicy = z.infer<typeof RetrievalPolicySchema>;
