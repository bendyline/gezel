import { z } from 'zod';
import { EntityIdSchema } from './entity-id.js';

export const PortableTransactionSchema = z
  .object({
    version: z.literal(1),
    id: EntityIdSchema,
    writes: z.array(z.object({ path: z.string(), staged: z.string() }).strict()).max(10000),
    removes: z.array(z.string()).max(10000),
    /** Reviewed restore roots removed before staged content is replayed. */
    clears: z.array(z.string()).max(10000).default([]),
    directories: z.array(z.string()).max(10000),
  })
  .strict();
