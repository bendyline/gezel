import { KnowledgeIdSchema } from '@bendyline/gezk';
import { z } from 'zod';

const label = z.string().min(1).max(256);
const message = z.string().max(2000);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const AppKnowledgeCatalogSchema = z
  .object({
    id: KnowledgeIdSchema,
    name: label,
    description: message,
    version: label,
    installedVersion: label.nullable(),
    enabled: z.boolean(),
    updateAvailable: z.boolean(),
    downloadBytes: count,
    documents: count,
    state: z.enum(['available', 'installed', 'downloading', 'error']),
    percent: z.number().min(0).max(100).nullable(),
    message: message.nullable(),
  })
  .strict();
export const AppKnowledgeStateSchema = z
  .object({
    catalogs: z.array(AppKnowledgeCatalogSchema).max(512),
    reranker: z
      .object({
        ready: z.boolean(),
        downloading: z.boolean(),
        message: message.nullable(),
      })
      .strict(),
  })
  .strict();
export const AppKnowledgeActionSchema = z.union([
  z
    .object({
      action: z.enum(['install', 'remove', 'enable', 'disable', 'cancel']),
      catalogId: KnowledgeIdSchema,
    })
    .strict(),
  z.object({ action: z.literal('prepare-reranker') }).strict(),
]);
export const AppKnowledgeQuerySchema = z
  .object({
    query: z.string().min(1).max(8192),
    rerank: z.literal('required'),
    maxResults: z.number().int().min(1).max(8),
    maxCharacters: z.number().int().min(1).max(24000),
  })
  .strict();
export const AppKnowledgeRetrievalSchema = z
  .object({
    reranked: z.literal(true),
    passages: z
      .array(
        z
          .object({
            uri: z.string().min(1).max(2048),
            title: label,
            text: z.string().max(24000),
            catalogId: KnowledgeIdSchema,
            version: label,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type AppKnowledgeState = z.infer<typeof AppKnowledgeStateSchema>;
export type AppKnowledgeAction = z.infer<typeof AppKnowledgeActionSchema>;
export type AppKnowledgeQuery = z.infer<typeof AppKnowledgeQuerySchema>;
export type AppKnowledgeRetrieval = z.infer<typeof AppKnowledgeRetrievalSchema>;
