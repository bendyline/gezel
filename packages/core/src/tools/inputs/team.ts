import { z } from 'zod';
import { ProjectRefSchema } from './common.js';

export const EnsureGezelInputSchema = z.object({ jobTitle: z.string().min(1).max(200) }).strict();

export const ListProjectGezelsInputSchema = z.object({ project: ProjectRefSchema }).strict();

export const AddGezelToProjectInputSchema = z
  .object({
    gezel: z.string().describe('Gezel id or display name'),
    project: ProjectRefSchema,
  })
  .strict();

/** One of `gezel` or `gezelId` names the target; the executor enforces that. */
export const MessageGezelInputSchema = z
  .object({
    gezel: z.string().optional().describe('Target gezel id or display name'),
    // `gezelId` is the spelling models reach for; without it the slip
    // surfaces as a raw MCP -32602 Zod dump and costs a turn. Same
    // precedent as `ask_user_question`'s `prompt` / `description`.
    gezelId: z.string().optional().describe('Alias for `gezel`.'),
    message: z.string().min(1).describe('What to ask or tell them'),
    project: z
      .string()
      .optional()
      .describe('Project id or name. Defaults to your current project.'),
  })
  .strict();
