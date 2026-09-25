import { z } from 'zod';
import { TaskRefSchema } from '../../schemas/task.js';
import { coerceJsonArray } from '../coerce.js';

/** One of `question`, `prompt` or `description` carries the text; the executor enforces that. */
export const AskUserQuestionInputSchema = z
  .object({
    question: z.string().optional().describe('The question to pose to the user. Markdown ok.'),
    // Common slip-ups some models reach for when they see an
    // "ask-a-question" tool — accept them so a naming mistake doesn't
    // surface as "technical error" to the user.
    prompt: z
      .string()
      .optional()
      .describe(
        'Alias for `question`; when both are supplied, this explanatory text is preserved.',
      ),
    description: z
      .string()
      .optional()
      .describe('Alias for `question`; distinct text is preserved below the question.'),
    choices: coerceJsonArray(
      z
        .array(z.string())
        .max(20)
        .optional()
        .describe(
          'Preset answer choices. **Always pass these when the answer is bounded** (pick a color, pick yes/no, pick one of three options). Omit only for genuinely open-ended questions. Must be an actual JSON array `["a","b"]`, not a stringified array.',
        ),
    ),
    allowWriteIn: z
      .boolean()
      .optional()
      .describe('Allow free-text alongside the choices. Default true.'),
    multiSelect: z
      .boolean()
      .optional()
      .describe('Let the user pick more than one choice. Default false.'),
    taskRef: TaskRefSchema.optional().describe(
      'Approval-flow context: a task this question is about, in `projectId/num` form. The current task is attached automatically in task sessions; pass this only to override it. The UI renders the task header above the prompt with an "Open task" link.',
    ),
    documentPath: z
      .string()
      .optional()
      .describe(
        "Approval-flow context: a file this question is about. Accepts any of: a path under the global documents library; a path under the current project's `documents/` folder (pass just the relative path — the UI prepends the project prefix); or a path under the project's `artifacts/` folder. The server resolves in that order — you don't need to know which bucket the file lives in. The UI renders a collapsed preview + \"Open …\" link with the kind chip matching what actually resolved.",
      ),
  })
  .strict();
