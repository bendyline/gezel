import { z } from 'zod';
import { KnowledgeDocumentIdSchema, KnowledgeIdSchema } from './ids.js';

/** A signed 32-bit listing position; unordered documents sort after ordered ones. */
export const KnowledgeOrdinalSchema = z.number().int().min(-2_147_483_648).max(2_147_483_647);

/**
 * Producer-defined document metadata, opaque to readers. Stored canonically
 * (RFC 8785) in `documents.meta_json`, bounded by
 * `MAX_KNOWLEDGE_DOCUMENT_META_BYTES`. Keys beginning with `gezk.` are
 * reserved for future versions of the format.
 */
export const KnowledgeDocumentMetaSchema = z.record(z.string(), z.unknown());
export type KnowledgeDocumentMeta = z.infer<typeof KnowledgeDocumentMetaSchema>;

/** One normalized document streamed into the compiler. */
export const CatalogDocumentSchema = z.object({
  id: KnowledgeDocumentIdSchema,
  title: z.string().min(1),
  slug: z.string().min(1),
  summary: z.string().optional(),
  language: z.string().min(2),
  /**
   * Root→leaf topic id path. Every segment must be a declared topic and each
   * must be the parent of the next; the document is filed at the last one.
   */
  topicPath: z.array(KnowledgeIdSchema).min(1),
  markdown: z.string(),
  sourceUrl: z.string().optional(),
  sourceRevision: z.string().optional(),
  sourceUpdatedAt: z.string().optional(),
  attribution: z.record(z.string(), z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  /** Explicit position among the documents of its topic in a listing. */
  ordinal: KnowledgeOrdinalSchema.optional(),
  meta: KnowledgeDocumentMetaSchema.optional(),
});
export type CatalogDocument = z.infer<typeof CatalogDocumentSchema>;
