import { z } from 'zod';

/**
 * Durable lineage for a session opened by work in another session.
 *
 * The parent is explicit rather than inferred from timestamps or task refs:
 * several task steps can start concurrently, and a role delegation or
 * consultation may not carry a task at all. Keeping the relationship on the
 * child lets persisted and live timelines reconstruct the same tree.
 *
 * The lineage contract has two halves with different jobs:
 * - `session.parentSession` — which session OPENED this thread. Stable
 *   containment: stamped at create, or retro-stamped first-parent-wins on
 *   the first delegated contact with an already-existing session. Never
 *   overwritten by later senders, or the session tree would reshuffle.
 * - `ChatMessage.from.sessionId`/`kind` — which session sent one SPECIFIC
 *   message. The per-edge ground truth, multi-parent capable; later
 *   delegations from other gezels live here, not on parentSession.
 * Replay/distillation readers take `from.sessionId` first and fall back to
 * delegation tool-call names only for records persisted before these fields.
 */
export const SessionLinkSchema = z.object({
  sessionId: z.string(),
  gezelId: z.string(),
});
export type SessionLink = z.infer<typeof SessionLinkSchema>;

export const SessionParentSchema = SessionLinkSchema.extend({
  kind: z.enum(['delegation', 'consultation', 'task-entry', 'task-handoff']),
});
export type SessionParent = z.infer<typeof SessionParentSchema>;
