import { z } from 'zod';
import { QuestionSchema } from './question.js';
import { QueueStatusResponseSchema } from './queue-status.js';
import { RequestTrackSchema } from './request-track.js';

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
  /**
   * Parked until a time (a cron tick, the Night Shift window), not waiting on
   * anything. Listed under Next, never counted in the header: the Meester's
   * nightly review is always here, so counting it reads as something to check.
   */
  scheduled: z.boolean().optional(),
  /** The person's request this row stands for (`RequestTrack.key`), when it is one. */
  requestKey: z.string().optional(),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const ActivityStatusResponseSchema = z.object({
  items: z.array(ActivityItemSchema),
  questions: z.array(QuestionSchema),
  queues: QueueStatusResponseSchema,
  at: z.string(),
  /** Requests still under way, for the title bar and the rows that stand for them. */
  requests: z.array(RequestTrackSchema).optional(),
});
export type ActivityStatusResponse = z.infer<typeof ActivityStatusResponseSchema>;
