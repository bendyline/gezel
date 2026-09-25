import { z } from 'zod';
import { ScriptScopeSchema } from '../../schemas/script.js';

export const ListScriptsInputSchema = z
  .object({
    project: z.string().optional().describe('Project id or name. Defaults to the current project.'),
  })
  .strict();

export const RunInstalledScriptInputSchema = z
  .object({
    project: z.string().optional(),
    name: z.string().describe('Script name (matches meta.name and the .ts filename).'),
    scope: ScriptScopeSchema.optional().describe(
      'Where the script is installed. Defaults to the project; "standard" names the built-in library.',
    ),
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const GetScriptRunInputSchema = z
  .object({
    project: z.string().optional(),
    runId: z.string(),
  })
  .strict();
