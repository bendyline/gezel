import { z } from 'zod';
import { TaskDeliverableSchema } from './referenced-file.js';

/** The fixed stops a request passes, in order: Got it → Making it → Checking it → Ready. */
export const RequestStopSchema = z.enum(['got-it', 'making', 'checking', 'ready']);
export type RequestStop = z.infer<typeof RequestStopSchema>;

/** Where the request is right now, as the person needs to know it. */
export const RequestStateSchema = z.enum(['working', 'waiting', 'needs-you', 'ready', 'stopped']);
export type RequestState = z.infer<typeof RequestStateSchema>;

/**
 * One person message and everything working on it: the tasks it caused, their
 * fanout shards, the sessions running them, and the questions they asked. One
 * tracker in the thread, one row in Activity, one phrase in the title bar.
 * Presentation only: the lead speaks for the crew here, but `makerGezelId`
 * and `actual` keep who really did the work.
 */
export const RequestTrackSchema = z.object({
  /** `<sessionId>@<at>` (`requestKey`). */
  key: z.string(),
  /** The thread the person wrote in. */
  sessionId: z.string(),
  projectId: z.string(),
  /** When they wrote it, and the message's id when the host stamped one. */
  at: z.string(),
  messageId: z.string().optional(),
  /** Their words, shortened. */
  summary: z.string(),
  /** `work` has tasks; `conversation` is a reply still being written. */
  kind: z.enum(['work', 'conversation']),
  /** Who the person hears from: the project's lead, else the thread's gezel. */
  leadGezelId: z.string().optional(),
  /** The furthest stop any of its work has reached. Never moves back. */
  stop: RequestStopSchema,
  state: RequestStateSchema,
  /** "{lead} is {doing}"; absent once it is ready with nothing more under way. */
  line: z.object({ gezelId: z.string().optional(), doing: z.string() }).optional(),
  /** The gezel and step really running now. The UI shows this only in debug mode. */
  actual: z
    .object({
      gezelId: z.string().optional(),
      taskRef: z.string(),
      stepId: z.string().optional(),
      stepName: z.string().optional(),
    })
    .optional(),
  eta: z
    .object({
      remainingMs: z.number().nonnegative(),
      firstTime: z.boolean(),
      overdue: z.boolean(),
      text: z.string(),
    })
    .optional(),
  /** Every task working on it: the ones it started, then their shards. */
  taskRefs: z.array(z.string()),
  /** Fanout progress across its shards. */
  parts: z.object({ done: z.number().int(), total: z.number().int() }).optional(),
  /** Sessions with a turn running for it right now. */
  liveSessionIds: z.array(z.string()),
  /** Everyone besides the lead who worked on it. */
  crew: z.array(z.string()),
  deliverable: TaskDeliverableSchema.optional(),
  makerGezelId: z.string().optional(),
  /** Ready, with the thread's gezel still writing its closing reply. */
  trailing: z.boolean().optional(),
  questionIds: z.array(z.string()),
});
export type RequestTrack = z.infer<typeof RequestTrackSchema>;

export const ListRequestsResponseSchema = z.object({
  requests: z.array(RequestTrackSchema),
  at: z.string(),
});
export type ListRequestsResponse = z.infer<typeof ListRequestsResponseSchema>;
