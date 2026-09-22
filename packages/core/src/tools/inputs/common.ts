import { z } from 'zod';

/** A tool that takes no arguments. Strict: a stray key is a mistake worth naming. */
export const EmptyInputSchema = z.object({}).strict();

export const ProjectRefSchema = z
  .string()
  .optional()
  .describe('Project id or name — defaults to your current project');

export const FilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .describe('File path relative to the project root.');

/** A 1-based line number for ranged reads. */
export const LineNumberSchema = z.number().int().min(1).max(10_000_000);

/**
 * A step as a model describes it when creating a task. The desktop extends
 * it with a `deliverable`, whose enforced gate needs the daemon's checkers.
 */
export const StepBlueprintSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().optional(),
  suggestedGezelId: z.string().optional(),
  suggestedRole: z
    .string()
    .optional()
    .describe('Role hint ("developer", "reviewer") resolved to a gezel at step activation.'),
  terminal: z.boolean().optional().describe('Final step — completing it completes the task.'),
});
