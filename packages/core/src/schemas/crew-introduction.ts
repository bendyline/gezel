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
 * Crew introduced in the thread the owner reads. `kickoff` is the lead and
 * whoever starts the work, posted as a task begins; `joined` is a gezel hired
 * for a later step, posted as they start. Both name their task. `hired` is a
 * gezel the thread's own gezel hired in conversation ("find me a
 * copywriter"): no task stands behind it, so it carries no `taskRef`.
 */
export const CrewIntroductionSchema = z.object({
  taskRef: z.string().optional(),
  moment: z.enum(['kickoff', 'joined', 'hired']),
  members: z.array(CrewMemberSchema).min(1),
});
export type CrewIntroduction = z.infer<typeof CrewIntroductionSchema>;

/** `POST /api/sessions/:id/crew-introduction`: gezels this session's turn just hired. */
export const IntroduceCrewRequestSchema = z.object({
  gezelIds: z.array(z.string().min(1)).min(1).max(8),
});
export type IntroduceCrewRequest = z.infer<typeof IntroduceCrewRequestSchema>;

/** The introduction is posted once the hiring turn has replied, so this only acknowledges it. */
export const IntroduceCrewResponseSchema = z.object({
  accepted: z.literal(true),
});
export type IntroduceCrewResponse = z.infer<typeof IntroduceCrewResponseSchema>;
