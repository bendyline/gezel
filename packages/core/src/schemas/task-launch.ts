import { z } from 'zod';
import { TaskAssigneeSchema } from './assignee.js';
import { TaskInputSourceSchema } from './task-inputs.js';

/**
 * A craftbook launch as the chat composer holds it: which book, which
 * parameters, which files. One shape serves three places — the prompt draft
 * it is parked on while the user is still typing, the request body that
 * turns it into a task, and the composer's own state — so a launch that was
 * configured in the New Task dialog, restored after a restart, and finally
 * sent is the same object throughout.
 *
 * `params` keeps the editor's raw values (numbers and booleans stay typed)
 * so a launch can be re-opened for editing; the service stringifies at
 * create time with the same coercion every other launcher uses.
 */
export const TaskLaunchSpecSchema = z.object({
  craftbookId: z.string().min(1),
  craftbookSourceId: z.string().optional(),
  title: z.string().optional(),
  assignee: TaskAssigneeSchema.optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  inputs: z.record(z.string(), TaskInputSourceSchema).optional(),
});
export type TaskLaunchSpec = z.infer<typeof TaskLaunchSpecSchema>;

/**
 * The launch as parked on a prompt draft. `origin` says whether the person
 * picked it or the daemon's route preview proposed it — a proposal is drawn
 * as tentative and may be replaced by a later proposal; a pick never is.
 * The display fields are conveniences for the composer's strip before the
 * catalog listing has answered.
 */
export const PromptDraftTaskLaunchSchema = TaskLaunchSpecSchema.extend({
  origin: z.enum(['user', 'suggested']),
  craftbookName: z.string().optional(),
  inputLabels: z
    .record(
      z.string(),
      z.object({
        label: z.string().optional(),
        fileCount: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
});
export type PromptDraftTaskLaunch = z.infer<typeof PromptDraftTaskLaunchSchema>;
