/**
 * Project-scoped discovery inputs, shared by client APIs and model tools.
 * Radius filters narrow knowledge subjects; they cannot widen a project's
 * catalog policy or silently mix geographic results with unlocated files.
 * Related files: api.ts, knowledge.ts, service/http/routes/tools.ts.
 */
import { KnowledgeIdSchema, KnowledgeRadiusSchema } from '@bendyline/gezk';
import { z } from 'zod';
import { RetrievalSourceSchema } from './retrieval.js';

/** Project-bound form used by the model-facing generic `search` tool. */
export const ProjectSearchRequestSchema = z
  .object({
    query: z.string().min(1).max(400),
    maxResults: z.number().int().positive().max(100).optional(),
    /**
     * Skip this many merged results before returning `maxResults` — the tool
     * cursor. Narrowing only; the project scope stays server-derived.
     */
    offset: z.number().int().nonnegative().max(10_000).optional(),
    /**
     * Keep only results whose path starts with this prefix (forward-slashed,
     * relative). Pathless results (memories, area overviews) are excluded when
     * set — a path filter asks for files. Narrowing only.
     */
    pathPrefix: z.string().min(1).max(500).optional(),
    /** Current gezel id enables its private-memory arm. */
    gezelId: z.string().min(1).optional(),
    /** Shared documents are included by default. */
    includeShared: z.boolean().optional(),
    sources: z.array(RetrievalSourceSchema).min(1).optional(),
    spatial: KnowledgeRadiusSchema.optional(),
    catalogs: z.array(KnowledgeIdSchema).max(256).optional(),
  })
  .superRefine((body, ctx) => {
    if (
      body.spatial &&
      (body.sources?.length !== 1 ||
        body.sources[0] !== 'knowledge' ||
        body.pathPrefix ||
        body.offset)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['spatial'],
        message:
          'Radius search requires sources=[knowledge] and no path prefix or offset; use nearby cursors for discovery.',
      });
    }
  });
export type ProjectSearchRequest = z.infer<typeof ProjectSearchRequestSchema>;
