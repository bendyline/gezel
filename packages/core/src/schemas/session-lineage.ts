import { z } from 'zod';

/**
 * Durable lineage for a session opened by work in another session.
 *
 * The parent is explicit rather than inferred from timestamps or task refs:
 * several task steps can start concurrently, and a role delegation or
 * consultation may not carry a task at all. Keeping the relationship on the
 * child lets persisted and live timelines reconstruct the same tree.
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
