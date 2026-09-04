import { z } from 'zod';
import { KnowledgeDocumentIdSchema, KnowledgeIdSchema } from './ids.js';

/** One normalized document streamed into the compiler. */
export const CatalogDocumentSchema = z.object({
  id: KnowledgeDocumentIdSchema,
  title: z.string().min(1),
  slug: z.string().min(1),
  summary: z.string().optional(),
  language: z.string().min(2),
  /** Root→leaf topic id path; the first segment must exist in the manifest. */
  topicPath: z.array(KnowledgeIdSchema).min(1),
  markdown: z.string(),
  sourceUrl: z.string().optional(),
  sourceRevision: z.string().optional(),
  sourceUpdatedAt: z.string().optional(),
  attribution: z.record(z.string(), z.string()).optional(),
  aliases: z.array(z.string()).optional(),
});
export type CatalogDocument = z.infer<typeof CatalogDocumentSchema>;
