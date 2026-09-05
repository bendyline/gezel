import { z } from 'zod';

/** Per-turn execution hint, never a grant of filesystem or tool authority. */
export const FileTurnIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create-file'), path: z.string().min(1).max(4096) }),
  z.object({
    kind: z.literal('repair-file'),
    path: z.string().min(1).max(4096),
    strategy: z.enum(['patch', 'rewrite']).optional(),
    readPaths: z.array(z.string().min(1).max(4096)).max(8).optional(),
    mutationPath: z.string().min(1).max(4096).optional(),
  }),
]);
export type FileTurnIntent = z.infer<typeof FileTurnIntentSchema>;
