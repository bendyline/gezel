import { z } from 'zod';
import {
  GEZK_FORMAT_GENERATIONS,
  GEZK_SUPPORTED_FORMAT_VERSIONS,
  GEZK_SUPPORTED_INDEX_SCHEMA_VERSIONS,
} from '../format/constants.js';
import {
  KnowledgeDocumentIdSchema,
  KnowledgeIdSchema,
  KnowledgeVersionSchema,
  Sha256HexSchema,
} from './ids.js';
import { KnowledgeChunkingProfileSchema, KnowledgeEmbeddingProfileSchema } from './profiles.js';

/**
 * `manifest.json` — the container's self-description. `formatVersion`
 * governs the container layout, `indexSchemaVersion` the SQLite DDL. Readers
 * never migrate a catalog: incompatibility is a typed disabled-with-reason
 * state, and a publisher's signed artifact is never rewritten.
 */

export const GEZK_MANIFEST_KIND = 'gezk-catalog';
export const GEZK_REGISTRY_KIND = 'gezk-registry';

export const KnowledgeManifestFileSchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: Sha256HexSchema,
});

export const KnowledgeSignatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  keyId: z.string().min(1),
  canonicalization: z.literal('rfc8785'),
  value: z.string().min(1),
});
export type KnowledgeSignature = z.infer<typeof KnowledgeSignatureSchema>;

export const KnowledgeCatalogManifestSchema = z
  .object({
    kind: z.literal(GEZK_MANIFEST_KIND),
    formatVersion: z.enum(GEZK_SUPPORTED_FORMAT_VERSIONS),
    indexSchemaVersion: z.union([z.literal(2), z.literal(3)]),
    id: KnowledgeIdSchema,
    version: KnowledgeVersionSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    language: z.string().min(2),
    publisher: z.object({
      id: KnowledgeIdSchema,
      name: z.string().min(1),
      url: z.string().optional(),
    }),
    createdAt: z.string(),
    sourceSnapshot: z
      .object({
        name: z.string(),
        date: z.string(),
        taxonomyVersion: z.string().optional(),
      })
      .optional(),
    license: z.object({
      name: z.string().min(1),
      /** SPDX identifier when one exists (e.g. `CC-BY-SA-4.0`). */
      spdx: z.string().optional(),
      /** Archive path of the human-readable notice (`LICENSES/catalog.txt`). */
      noticePath: z.string().min(1),
      attributionRequired: z.boolean(),
    }),
    embedding: KnowledgeEmbeddingProfileSchema,
    chunking: KnowledgeChunkingProfileSchema,
    topics: z
      .array(
        z.object({
          id: KnowledgeIdSchema,
          name: z.string().min(1),
          /** Absent for a root topic; names another entry of this list. */
          parentId: KnowledgeIdSchema.optional(),
          /** Sibling ordering key, identical to `topics.sort_key` in the router. */
          sortKey: z.string().min(1).optional(),
          description: z.string().optional(),
        }),
      )
      .min(1, 'a catalog must ship a table of contents (at least one topic)'),
    router: z.object({
      shardTargetChunks: z.number().int().positive(),
      shards: z.array(
        z.object({
          id: z.number().int().nonnegative(),
          path: z.string().min(1),
          chunks: z.number().int().nonnegative(),
          documents: z.number().int().nonnegative(),
          centroids: z.number().int().nonnegative(),
          sha256: Sha256HexSchema,
        }),
      ),
      totalCentroids: z.number().int().nonnegative(),
    }),
    counts: z.object({
      documents: z.number().int().nonnegative(),
      chunks: z.number().int().nonnegative(),
      shards: z.number().int().positive(),
      /** Files under `assets/` (0.6+). */
      assets: z.number().int().nonnegative().optional(),
    }),
    files: z.array(KnowledgeManifestFileSchema).min(1),
    /** What a reader must implement to open this catalog. */
    requires: z.object({
      formatVersion: z.enum(GEZK_SUPPORTED_FORMAT_VERSIONS),
      features: z.array(z.string()).optional(),
    }),
    smokeQueries: z
      .array(
        z.object({
          query: z.string().min(1),
          expectedDocumentIds: z.array(KnowledgeDocumentIdSchema).min(1),
        }),
      )
      .optional(),
    /** Which tool produced the archive — provenance, never a compatibility gate. */
    toolchain: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        node: z.string().optional(),
        sqlite: z.string().optional(),
        platform: z.string().optional(),
        modelDigest: z.string().optional(),
        tokenizerDigest: z.string().optional(),
      })
      .optional(),
    signature: KnowledgeSignatureSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    if (GEZK_FORMAT_GENERATIONS[manifest.formatVersion] !== manifest.indexSchemaVersion) {
      ctx.addIssue({
        code: 'custom',
        path: ['indexSchemaVersion'],
        message: `format ${manifest.formatVersion} pairs with index schema ${GEZK_FORMAT_GENERATIONS[manifest.formatVersion]}, not ${manifest.indexSchemaVersion}`,
      });
    }
    if (manifest.requires.formatVersion !== manifest.formatVersion) {
      ctx.addIssue({
        code: 'custom',
        path: ['requires', 'formatVersion'],
        message: 'requires.formatVersion must equal formatVersion',
      });
    }
    if (manifest.formatVersion === '0.5' && manifest.counts.assets !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['counts', 'assets'],
        message: 'counts.assets is a 0.6 field',
      });
    }
    const topicIds = new Set<string>();
    manifest.topics.forEach((topic, index) => {
      if (topicIds.has(topic.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['topics', index, 'id'],
          message: `duplicate topic id '${topic.id}'`,
        });
      }
      topicIds.add(topic.id);
    });
    manifest.topics.forEach((topic, index) => {
      if (topic.parentId !== undefined && !topicIds.has(topic.parentId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['topics', index, 'parentId'],
          message: `topic '${topic.id}' names an undeclared parent '${topic.parentId}'`,
        });
      }
    });
  });
export type KnowledgeCatalogManifest = z.infer<typeof KnowledgeCatalogManifestSchema>;
/** The (formatVersion, indexSchemaVersion) pairs the manifest schema admits. */
export const KNOWLEDGE_MANIFEST_INDEX_SCHEMA_VERSIONS = GEZK_SUPPORTED_INDEX_SCHEMA_VERSIONS;

/** `LICENSES/source-notices.json` — per-source attribution for combined catalogs. */
export const SourceNoticesSchema = z.object({
  sources: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.string().optional(),
        license: z.string().min(1),
        licenseUrl: z.string().optional(),
        /** Snapshot or revision the content was taken from. */
        snapshot: z.string().optional(),
        /** Free-form notice text required by the source's license. */
        notice: z.string().optional(),
      }),
    )
    .min(1),
});
export type SourceNotices = z.infer<typeof SourceNoticesSchema>;
