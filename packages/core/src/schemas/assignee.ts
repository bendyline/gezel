import { z } from 'zod';

/**
 * Who's responsible for a task or step. Shared across task.ts and
 * craftbook.ts; lives in its own file to avoid the circular import that
 * would form between them.
 */
export const TaskAssigneeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gezel'), gezelId: z.string() }),
  z.object({ kind: z.literal('user') }),
]);
export type TaskAssignee = z.infer<typeof TaskAssigneeSchema>;
