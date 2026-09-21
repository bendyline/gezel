import { z } from 'zod';
/** Transport-independent input contracts used by the MCP and embedded hosts. */
export const ListDirectoryInputSchema = z.object({ path: z.string().optional() }).strict();
export const ReadDocumentInputSchema = z.object({ path: z.string() }).strict();
export const WriteDocumentInputSchema = z
  .object({ path: z.string(), content: z.string() })
  .strict();
export const EnsureGezelInputSchema = z.object({ jobTitle: z.string().min(1).max(200) }).strict();

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
