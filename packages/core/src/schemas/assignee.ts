import { z } from 'zod';

/**
 * Who's responsible for a task or step. Shared across task.ts and
 * craftbook.ts; lives in its own file to avoid the circular import that
 * would form between them.
 */
export const UserTaskInstructionsSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    'Explain exactly what the person needs to do and how to confirm they are ready: for example, add a launch date to the task description, then confirm it in the reply. Address the person as "you". Include this whenever assigning work to the user; never just say "open the task".',
  );

export const TaskAssigneeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gezel'), gezelId: z.string() }),
  z.object({ kind: z.literal('user'), instructions: UserTaskInstructionsSchema.optional() }),
]);
export type TaskAssignee = z.infer<typeof TaskAssigneeSchema>;
