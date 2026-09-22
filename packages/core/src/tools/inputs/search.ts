import { z } from 'zod';

export const SearchInputSchema = z
  .object({
    query: z.string().min(1).describe('Natural-language description or keywords.'),
    maxResults: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum results to request. Each host caps this to what it can afford.'),
  })
  .strict();
