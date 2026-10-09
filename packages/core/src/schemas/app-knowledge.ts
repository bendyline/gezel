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
    /**
     * `required` refuses (409 `reranker_required`) without the relevance
     * model. `auto` uses the model when it is installed and otherwise admits
     * only hits that clear Gezel's own bar for unjudged catalog passages.
     */
    rerank: z.enum(['required', 'auto']),
    maxResults: z.number().int().min(1).max(8),
    maxCharacters: z.number().int().min(1).max(24000),
  })
  .strict();
export const AppKnowledgeRetrievalSchema = z
  .object({
    /** False only when an `auto` query was answered without the relevance model. */
    reranked: z.boolean(),
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
/**
 * `GET /v1/knowledge/relevance`: the optional model that ranks passages. A
 * separate route rather than new `/state` fields, because SDKs parse `/state`
 * strictly and older ones would reject an unknown key.
 */
export const AppKnowledgeRelevanceSchema = z
  .object({
    ready: z.boolean(),
    downloading: z.boolean(),
    percent: z.number().min(0).max(100).nullable(),
    /** Approximate download size; null when this Gezel cannot download it. */
    downloadBytes: count,
  })
  .strict();
export type AppKnowledgeState = z.infer<typeof AppKnowledgeStateSchema>;
export type AppKnowledgeRelevance = z.infer<typeof AppKnowledgeRelevanceSchema>;
export type AppKnowledgeAction = z.infer<typeof AppKnowledgeActionSchema>;
export type AppKnowledgeQuery = z.infer<typeof AppKnowledgeQuerySchema>;
export type AppKnowledgeRetrieval = z.infer<typeof AppKnowledgeRetrievalSchema>;
