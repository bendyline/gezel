import { z } from 'zod';
import { MEMORY_KINDS, MEMORY_SCOPES } from '../../runtime/memory-markdown.js';

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
      .enum(MEMORY_SCOPES)
      .describe(
        'Where to save: "user" for something the person tells you about themselves while talking with you (every gezel reads it; refused outside their turn), "gezel" for how you do your own work well, "project" for project-shared context',
      ),
    kind: z
      .enum(MEMORY_KINDS)
      .optional()
      .describe(
        'What kind of memory: "fact" (durable fact — the default), "decision" (a choice made), "pref" (a preference or working style), "status" (a temporary condition true right now), "correction" (a mistake and its fix), "example" (a worked example worth repeating)',
      ),
  })
  .strict();
