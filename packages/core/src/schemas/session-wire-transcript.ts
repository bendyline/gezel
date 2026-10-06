import { z } from 'zod';

/**
 * A stateless session's exact wire transcript, checkpointed on disk so a
 * restart can reseed the session with the prompt its engine last cached.
 *
 * A local engine keeps its KV cache across restarts, but a cache is only
 * worth something to a prompt that starts with the same tokens. The usual
 * rebuild from saved history (`buildToolEvidenceReplay`) dedupes, budgets,
 * and labels tool results on purpose, so it agrees with the cached prompt
 * only up to the system message. Measured: a restarted 69k-token task turn
 * matched 14k cached tokens and re-prefilled 55k, about four minutes on a
 * 27B, while a person's chat waited behind it.
 *
 * Internal format, written and read only by the daemon (`Store`).
 */
export const WireTranscriptEntrySchema = z.union([
  z.object({ role: z.literal('tool'), content: z.string(), toolCallId: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string() })),
  }),
  z.object({ role: z.enum(['user', 'assistant']), content: z.string() }),
]);

export const SessionWireTranscriptSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  /** Provider whose session produced the transcript; a different one never reuses it. */
  providerName: z.string(),
  savedAt: z.string(),
  /**
   * True for a checkpoint taken before an engine request, mid-turn; false for
   * one taken after the turn's outcome was persisted.
   */
  inTurn: z.boolean(),
  /**
   * The saved session as it stood when the checkpoint was taken: its message
   * count and a digest of those messages. A restore whose record no longer
   * matches falls back to the rebuild from saved history.
   */
  basis: z.object({ count: z.number().int().nonnegative(), digest: z.string() }),
  transcript: z.array(WireTranscriptEntrySchema),
});
export type SessionWireTranscript = z.infer<typeof SessionWireTranscriptSchema>;
