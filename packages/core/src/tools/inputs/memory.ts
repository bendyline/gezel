import { z } from 'zod';

export const SearchMemoryInputSchema = z
  .object({
    query: z.string().describe('What to search for in memory'),
    topK: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Max memories to return (default 10).'),
  })
  .strict();

export const SaveMemoryInputSchema = z
  .object({
    text: z.string().describe('The memory to save — a concise fact or observation'),
    scope: z
      .enum(['gezel', 'project'])
      .describe(
        'Where to save: "gezel" for your own personal memories, "project" for project-shared context',
      ),
    kind: z
      .enum(['fact', 'decision', 'pref', 'status'])
      .optional()
      .describe(
        'What kind of memory: "fact" (durable fact — the default), "decision" (a choice made), "pref" (a preference or working style), "status" (a temporary condition true right now)',
      ),
  })
  .strict();
