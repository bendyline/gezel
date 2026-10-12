import { z } from 'zod';

/**
 * One gezel the owner's thread introduces: who they are in plain words and
 * what they will do for this goal. The UI draws it as a card with their
 * portrait; the message's text carries the same facts for the model.
 */
export const CrewMemberSchema = z.object({
  gezelId: z.string(),
  name: z.string(),
  /** The role as the gezel carries it ("Reisleider"). */
  role: z.string().optional(),
  /** Plain words beside a guild role ("trip planner"); absent when the role is plain already. */
  gloss: z.string().optional(),
  /** What they do, in a sentence (the template's own description). */
  purpose: z.string().optional(),
  /** The step they start with. */
  stepName: z.string().optional(),
});
export type CrewMember = z.infer<typeof CrewMemberSchema>;

/**
 * The crew a task brought, introduced in the thread that launched it.
 * `kickoff` is the lead and whoever starts the work, posted as the task
 * begins; `joined` is a gezel hired for a later step, posted as they start.
 */
export const CrewIntroductionSchema = z.object({
  taskRef: z.string(),
  moment: z.enum(['kickoff', 'joined']),
  members: z.array(CrewMemberSchema).min(1),
});
export type CrewIntroduction = z.infer<typeof CrewIntroductionSchema>;
