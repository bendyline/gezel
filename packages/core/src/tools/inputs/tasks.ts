import { z } from 'zod';
import { TaskAssigneeSchema } from '../../schemas/assignee.js';
import { coerceJsonArray } from '../coerce.js';
import { StepBlueprintSchema } from './common.js';

export const ReadTaskNotesInputSchema = z
  .object({
    ref: z.string(),
    stepId: z.string().optional(),
  })
  .strict();

export const WriteTaskNoteInputSchema = z
  .object({
    ref: z.string(),
    text: z
      .string()
      .min(1)
      .optional()
      .describe('The note body. Markdown ok. Required unless you pass `note` / `content` instead.'),
    // `note` and `content` are the two names models reach for on a tool
    // called `write_task_note`. `write_task_note` is the single most common
    // argument-validation failure in the whole eval corpus, and `content` is
    // not even a guess — the shipped `investigate` and `pull-request-review`
    // craftbooks instruct the assignee to call
    // `write_task_note({ ref, content: … })`, so following the catalog
    // verbatim earns a -32602. The rejection happens in the SDK's schema
    // validation before the handler runs, so no coercion layer downstream can
    // rescue it: the model burns a turn re-reading the schema. Same precedent
    // as `ask_user_question`'s `prompt` / `description` aliases.
    note: z.string().min(1).optional().describe('Alias for `text`.'),
    content: z.string().min(1).optional().describe('Alias for `text`.'),
    stepId: z.string().optional(),
  })
  .strict();

/**
 * The fields both hosts accept. The desktop adds catalog craftbooks, cron,
 * fan-out and per-step deliverables on top; the portable host needs `steps`
 * spelled out, which its executor checks.
 */
export const CreateTaskInputSchema = z
  .object({
    project: z.string().describe('Project id'),
    title: z.string().min(1),
    description: z
      .string()
      .min(40)
      .describe(
        "The job-to-be-done. State the problem from the user's perspective — what does success look like? " +
          'Bad: "set up the website". Good: "Eliza wants an online shop for her pet care services so walk-in ' +
          'customers can book appointments online; success means a working checkout flow by end of month." ' +
          "The voorman landing on this task later reads this and needs to actually know what they're solving.",
      ),
    plan: z
      .string()
      .optional()
      .describe(
        "The voorman's approach. Usually omitted at creation and filled in later via update_task once the " +
          'work has been scoped. Distinct from per-step notes (the progress log) — this is the plan.',
      ),
    assignee: TaskAssigneeSchema.optional(),
    steps: coerceJsonArray(
      z
        .array(StepBlueprintSchema)
        .optional()
        .describe('Inline steps for an ad-hoc craftbook embedded directly in this task.'),
    ),
  })
  .strict();

export const AdvanceTaskStepInputSchema = z
  .object({
    ref: z.string(),
    stepId: z.string().describe('Id of the step to complete'),
    next: z
      .string()
      .optional()
      .describe(
        'Id of the step to activate next, or "next" / omit to advance to the following step in order.',
      ),
  })
  .strict();

export const ListTasksInputSchema = z
  .object({
    project: z.string().optional(),
    status: z.enum(['draft', 'paused', 'active', 'complete', 'canceled']).optional(),
    assignee: z.string().optional().describe('gezel id'),
  })
  .strict();

export const GetTaskInputSchema = z
  .object({ ref: z.string().describe('Task ref, e.g. "marketing/7"') })
  .strict();
