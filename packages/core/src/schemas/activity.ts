import { z } from 'zod';
import { QuestionSchema } from './question.js';
import { QueueStatusResponseSchema } from './queue-status.js';

export const ActivitySectionSchema = z.enum(['needs-you', 'working', 'next', 'ready']);
export type ActivitySection = z.infer<typeof ActivitySectionSchema>;

/** A piece of work, joined by task or session identity, never by its label. */
export const ActivityItemSchema = z.object({
  id: z.string(),
  section: ActivitySectionSchema,
  title: z.string(),
  detail: z.string(),
  projectId: z.string().optional(),
  gezelId: z.string().optional(),
  taskRef: z.string().optional(),
  sessionId: z.string().optional(),
  questionIds: z.array(z.string()),
  since: z.string().optional(),
  /** Links to the existing activity setting; changing it is always explicit. */
  heldByActivity: z.boolean().optional(),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const ActivityStatusResponseSchema = z.object({
  items: z.array(ActivityItemSchema),
  questions: z.array(QuestionSchema),
  queues: QueueStatusResponseSchema,
  at: z.string(),
});
export type ActivityStatusResponse = z.infer<typeof ActivityStatusResponseSchema>;
