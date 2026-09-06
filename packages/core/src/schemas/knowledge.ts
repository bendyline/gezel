import {
  KnowledgeIdSchema,
  KnowledgeRegistryEntrySchema,
  KnowledgeVersionSchema,
  Sha256HexSchema,
} from '@bendyline/gezk';
import { z } from 'zod';

/**
 * Knowledge catalogs — gezel's product-side contracts around the `.gezk`
 * format: the per-user registry, the machine inventory, project scope, HTTP
 * request shapes and history events. The format itself (manifest, registry
 * index, profiles, id grammars, `knowledge://` references) is owned by
 * @bendyline/gezk and re-exported here so product code keeps one import.
 */

// Explicit names, not `export *`: esbuild lowers a star re-export of an
// external package to a runtime namespace copy, which never reaches this
// bundle's top-level exports (the format names then resolve to undefined in
// every consumer). knowledge-reexports.test.ts keeps this list complete.
export {
  ASSETS_PREFIX,
  ArtifactDigestSchema,
  CatalogDocumentSchema,
  DEFAULT_EMBEDDING_ONNX_FILE,
  DEFAULT_EMBEDDING_TOKENIZER_FILE,
  GEZK_APPLICATION_ID,
  GEZK_FORMAT_GENERATIONS,
  GEZK_FORMAT_VERSION,
  GEZK_INDEX_SCHEMA_VERSION,
  GEZK_MANIFEST_KIND,
  GEZK_MIME_TYPE,
  GEZK_REGISTRY_KIND,
  GEZK_SUPPORTED_FORMAT_VERSIONS,
  GEZK_SUPPORTED_INDEX_SCHEMA_VERSIONS,
  KNOWLEDGE_ASSET_PATH_PATTERN,
  KNOWLEDGE_ASSET_TYPES,
  KNOWLEDGE_ID_PATTERN,
  KNOWLEDGE_MANIFEST_INDEX_SCHEMA_VERSIONS,
  KNOWLEDGE_VERSION_PATTERN,
  KnowledgeAssetPathSchema,
  KnowledgeCatalogManifestSchema,
  KnowledgeChunkUidSchema,
  KnowledgeChunkingProfileSchema,
  KnowledgeDocumentIdSchema,
  KnowledgeDocumentMetaSchema,
  KnowledgeEmbeddingProfileSchema,
  KnowledgeIdSchema,
  KnowledgeManifestFileSchema,
  KnowledgeOrdinalSchema,
  KnowledgeRegistryEntrySchema,
  KnowledgeRegistryIndexSchema,
  KnowledgeSignatureSchema,
  KnowledgeVectorEncodingSchema,
  KnowledgeVersionSchema,
  LICENSE_NOTICE_PATH,
  MANIFEST_PATH,
  MIMETYPE_PATH,
  README_PATH,
  ROUTER_DB_PATH,
  RepoRelativePathSchema,
  SOURCE_NOTICES_PATH,
  Sha256HexSchema,
  SourceNoticesSchema,
  assetContentType,
  assetExtension,
  assetKindForExtension,
  embeddingProfileArtifacts,
  formatKnowledgeUri,
  isKnowledgeAssetPath,
  isSupportedFormatVersion,
  isSupportedIndexSchemaVersion,
  parseKnowledgeUri,
  sameVectorSpace,
  topicSortKeyForOrder,
} from '@bendyline/gezk';
export type {
  CatalogDocument,
  GezkFormatVersion,
  GezkIndexSchemaVersion,
  KnowledgeAssetExtension,
  KnowledgeAssetKind,
  KnowledgeCatalogManifest,
  KnowledgeChunkingProfile,
  KnowledgeDocumentMeta,
  KnowledgeEmbeddingProfile,
  KnowledgeRegistryEntry,
  KnowledgeRegistryIndex,
  KnowledgeSignature,
  KnowledgeUri,
  KnowledgeVectorEncoding,
  SourceNotices,
} from '@bendyline/gezk';

/**
 * Embedding profiles the daemon can produce query vectors for. A gilde
 * `knowledge-catalog` entry may only advertise one of these; the knowledge
 * package's profile registry test asserts the two lists stay identical.
 */
export const KNOWLEDGE_EMBEDDING_PROFILE_IDS = [
  'multilingual-e5-small@1',
  'bge-small-en-v1.5@1',
] as const;
export type KnowledgeEmbeddingProfileId = (typeof KNOWLEDGE_EMBEDDING_PROFILE_IDS)[number];

// ── the immutable catalog reference + user registry ─────────────────────────

export const KnowledgeStorageScopeSchema = z.enum(['machine-shared', 'user']);
export type KnowledgeStorageScope = z.infer<typeof KnowledgeStorageScopeSchema>;

/** How a catalog reached this user's registry: a gilde entry, a local file, or a URL. */
export const KnowledgeInstallSourceKindSchema = z.enum(['gilde', 'file', 'url']);
export type KnowledgeInstallSourceKind = z.infer<typeof KnowledgeInstallSourceKindSchema>;

/** The full immutable identity a user registry entry pins. */
export const KnowledgeCatalogRefSchema = z.object({
  publisherId: KnowledgeIdSchema,
  catalogId: KnowledgeIdSchema,
  version: KnowledgeVersionSchema,
  contentDigest: Sha256HexSchema,
  storageScope: KnowledgeStorageScopeSchema,
});
export type KnowledgeCatalogRef = z.infer<typeof KnowledgeCatalogRefSchema>;

/**
 * `~/.gezel/knowledge/registry.json` — the authoritative record of what THIS
 * user installed/enabled. The manager never scans storage trees and applies
 * an implicit precedence rule; the registry is the truth (a deliberate
 * divergence from the definition-file-presence pattern used by gezel/project
 * storage scopes — recorded in docs/knowledge-catalogs.md).
 */
export const KnowledgeUserRegistrySchema = z.object({
  version: z.literal(1),
  catalogs: z.array(
    z.object({
      ref: KnowledgeCatalogRefSchema,
      enabled: z.boolean(),
      addedAt: z.string(),
      autoUpdate: z.boolean().optional(),
      /** Where the install came from; entries written before it was recorded carry none. */
      source: KnowledgeInstallSourceKindSchema.optional(),
      /** Set when the manager quarantined this catalog (with the reason). */
      disabledReason: z.string().optional(),
    }),
  ),
});
export type KnowledgeUserRegistry = z.infer<typeof KnowledgeUserRegistrySchema>;

/** `assets/knowledge/inventory.json` — which public immutable bytes exist. */
export const KnowledgeMachineInventorySchema = z.object({
  version: z.literal(1),
  catalogs: z.array(
    z.object({
      publisherId: KnowledgeIdSchema,
      catalogId: KnowledgeIdSchema,
      version: KnowledgeVersionSchema,
      contentDigest: Sha256HexSchema,
      publishedAt: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
});
export type KnowledgeMachineInventory = z.infer<typeof KnowledgeMachineInventorySchema>;

/** What the user daemon may send the broker: a signed coordinate, nothing else. */
export const TrustedKnowledgeCoordinateSchema = z.object({
  publisherId: KnowledgeIdSchema,
  catalogId: KnowledgeIdSchema,
  version: KnowledgeVersionSchema,
  expectedDigest: Sha256HexSchema,
});
export type TrustedKnowledgeCoordinate = z.infer<typeof TrustedKnowledgeCoordinateSchema>;

// ── project scope ───────────────────────────────────────────────────────────

export const ProjectKnowledgeCatalogsSchema = z.object({
  mode: z.enum(['inherit', 'selected', 'off']),
  /**
   * Only for mode 'selected'. Unresolvable refs are RETAINED (not stripped)
   * so a restored project regains its selection when the catalog returns.
   */
  refs: z
    .array(z.object({ publisherId: KnowledgeIdSchema, catalogId: KnowledgeIdSchema }))
    .optional(),
});
export type ProjectKnowledgeCatalogs = z.infer<typeof ProjectKnowledgeCatalogsSchema>;

// ── catalog browsing and updates (gilde-backed) ─────────────────────────────

/** The Hugging Face dataset coordinates a gilde `knowledge-catalog` version pins. */
export const KnowledgeHuggingfaceFileSchema = z.object({
  repo: z.string(),
  /** A 40-hex commit sha, so the pinned URL is immutable. */
  revision: z.string(),
  path: z.string(),
});
export type KnowledgeHuggingfaceFile = z.infer<typeof KnowledgeHuggingfaceFileSchema>;

/**
 * One available upgrade: an installed catalog for which the shipped gilde
 * content carries a strictly newer version. The gilde pin (sha256 + commit)
 * is the trust root, exactly as it is for models.
 */
export const KnowledgeUpdateCandidateSchema = z.object({
  publisherId: KnowledgeIdSchema,
  catalogId: KnowledgeIdSchema,
  name: z.string(),
  installedVersion: z.string(),
  availableVersion: z.string(),
  releasedAt: z.string(),
  archiveBytes: z.number().int().nonnegative(),
  contentDigest: Sha256HexSchema,
  huggingface: KnowledgeHuggingfaceFileSchema,
});
export type KnowledgeUpdateCandidate = z.infer<typeof KnowledgeUpdateCandidateSchema>;

export const KnowledgeUpdatesResponseSchema = z.object({
  source: z.literal('gilde'),
  checkedAt: z.string(),
  updates: z.array(KnowledgeUpdateCandidateSchema),
});
export type KnowledgeUpdatesResponse = z.infer<typeof KnowledgeUpdatesResponseSchema>;

export const KnowledgeSemanticSearchModeSchema = z.enum(['shared', 'profile', 'keyword-only']);
export type KnowledgeSemanticSearchMode = z.infer<typeof KnowledgeSemanticSearchModeSchema>;

/** One installed catalog as reported by `GET /api/knowledge/catalogs`. */
export const KnowledgeCatalogStatusSchema = z.object({
  ref: KnowledgeCatalogRefSchema,
  enabled: z.boolean(),
  addedAt: z.string(),
  disabledReason: z.string().optional(),
  mounted: z.boolean(),
  name: z.string().optional(),
  description: z.string().optional(),
  language: z.string().optional(),
  license: z.string().optional(),
  documents: z.number().int().nonnegative().optional(),
  chunks: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  /** False only for `keyword-only` catalogs (an unregistered embedding profile). */
  vectorCompatible: z.boolean().optional(),
  /**
   * `shared` — queries reuse the daemon's own embedder; `profile` — the
   * catalog's model is loaded to embed queries; `keyword-only` — no model
   * gezel can run matches the profile, so only full-text search applies.
   */
  semanticSearch: KnowledgeSemanticSearchModeSchema.optional(),
  source: KnowledgeInstallSourceKindSchema,
  /** A strictly newer version exists in the shipped catalog content. */
  updateAvailable: z.boolean(),
  availableVersion: z.string().optional(),
});
export type KnowledgeCatalogStatus = z.infer<typeof KnowledgeCatalogStatusSchema>;

/** `GET /api/knowledge/available`: a gilde entry joined with this user's state. */
export const KnowledgeAvailableCatalogSchema = z.object({
  id: KnowledgeIdSchema,
  publisherId: KnowledgeIdSchema,
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  language: z.string(),
  category: z.string().optional(),
  license: z.string().optional(),
  licenseUrl: z.string().optional(),
  version: z.string(),
  releasedAt: z.string(),
  formatVersion: z.string(),
  huggingface: KnowledgeHuggingfaceFileSchema,
  upstream: z.string().optional(),
  parquet: z.object({ repo: z.string(), revision: z.string(), dir: z.string() }).optional(),
  sha256: Sha256HexSchema,
  archiveBytes: z.number().int().nonnegative(),
  uncompressedBytes: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  embeddingProfile: z.object({ id: z.string(), modelRepo: z.string() }),
  topics: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      parentId: z.string().optional(),
      sortKey: z.string().optional(),
    }),
  ),
  minGezelVersion: z.string().optional(),
  /** Present when this user's registry holds a version of the catalog. */
  installed: z
    .object({
      version: z.string(),
      contentDigest: Sha256HexSchema,
      storageScope: KnowledgeStorageScopeSchema,
      enabled: z.boolean(),
      updateAvailable: z.boolean(),
    })
    .optional(),
  /** The pinned bytes already sit in the machine-shared asset store. */
  sharedOnDevice: z.boolean(),
  installing: z.boolean(),
  /** A resumable partial download of the pinned archive exists. */
  incompleteDownload: z.boolean(),
});
export type KnowledgeAvailableCatalog = z.infer<typeof KnowledgeAvailableCatalogSchema>;

// ── install jobs ────────────────────────────────────────────────────────────

export const KnowledgeInstallPhaseSchema = z.enum(['download', 'extract', 'embedder']);
export type KnowledgeInstallPhase = z.infer<typeof KnowledgeInstallPhaseSchema>;

/** Events an install job streams (`GET /jobs/:id/events`, `POST /catalogs/:id/install`). */
export const KnowledgeInstallEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    phase: KnowledgeInstallPhaseSchema,
    bytesDone: z.number().nonnegative(),
    bytesTotal: z.number().nonnegative(),
  }),
  z.object({ type: z.literal('verifying') }),
  z.object({
    type: z.literal('retrying'),
    attempt: z.number().int(),
    maxAttempts: z.number().int(),
    delayMs: z.number().nonnegative(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('done'),
    ref: KnowledgeCatalogRefSchema,
    rootDir: z.string(),
    storageScope: KnowledgeStorageScopeSchema,
    /** Installed and mounted, but an optional step (the query embedder) did not complete. */
    warning: z.string().optional(),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
    /** Set when the downloaded bytes did not match the pinned digest. */
    mismatch: z.object({ expected: Sha256HexSchema, actual: Sha256HexSchema }).optional(),
  }),
]);
export type KnowledgeInstallEvent = z.infer<typeof KnowledgeInstallEventSchema>;

export const KnowledgeInstallJobSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  finished: z.boolean(),
  error: z.string().optional(),
  /** The latest progress event and, once finished, the terminal event. */
  events: z.array(KnowledgeInstallEventSchema),
});
export type KnowledgeInstallJob = z.infer<typeof KnowledgeInstallJobSchema>;

export const KnowledgeActiveInstallSchema = z.object({
  jobId: z.string(),
  /** Known up front for catalog installs; a file/URL install learns it at `done`. */
  catalogId: KnowledgeIdSchema.optional(),
  startedAt: z.string(),
  phase: z.enum(['download', 'verifying', 'extract', 'embedder', 'retrying']),
  bytesDone: z.number().nonnegative(),
  bytesTotal: z.number().nonnegative(),
});
export type KnowledgeActiveInstall = z.infer<typeof KnowledgeActiveInstallSchema>;

/** A `.partial` archive under `~/.gezel/knowledge/downloads/` that no job is writing. */
export const IncompleteKnowledgeDownloadSchema = z.object({
  /** The temp-file stem: the pinned sha256's first 16 hex chars, or a hash of the URL. */
  key: z.string().regex(/^[0-9a-f]{16}$/),
  bytes: z.number().int().nonnegative(),
  updatedAt: z.string(),
  /** True when the key still matches a catalog entry, so a re-install resumes it. */
  resumable: z.boolean(),
  catalogId: KnowledgeIdSchema.optional(),
  name: z.string().optional(),
  archiveBytes: z.number().int().nonnegative().optional(),
});
export type IncompleteKnowledgeDownload = z.infer<typeof IncompleteKnowledgeDownloadSchema>;

// ── HTTP request shapes ─────────────────────────────────────────────────────

export const KnowledgeInstallRequestSchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path: z.string().min(1) }),
    z.object({
      kind: z.literal('url'),
      url: z.string().url(),
      /** Optional out-of-band identity for remote imports. When present, the
       * daemon rejects bytes that do not match before extracting the archive. */
      expectedSha256: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/)
        .optional(),
    }),
    z.object({
      kind: z.literal('catalog'),
      /** A gilde `knowledge-catalog` id; its pinned sha256 + commit are the trust root. */
      id: KnowledgeIdSchema,
      version: z.string().optional(),
      /** `auto` (default) prefers the machine-shared store when a machine engine is adopted. */
      placement: z.enum(['auto', 'user']).optional(),
    }),
  ]),
});
export type KnowledgeInstallRequest = z.infer<typeof KnowledgeInstallRequestSchema>;

export const UpdateKnowledgeCatalogRequestSchema = z.object({
  enabled: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
});
export type UpdateKnowledgeCatalogRequest = z.infer<typeof UpdateKnowledgeCatalogRequestSchema>;

// ── catalog browsing responses ──────────────────────────────────────────────

/** One topic of a mounted catalog's shipped table of contents. */
export const KnowledgeTopicNodeSchema = z.object({
  id: KnowledgeIdSchema,
  parentId: KnowledgeIdSchema.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  sortKey: z.string(),
  /** Documents filed directly at this topic. */
  documentCount: z.number().int().nonnegative(),
  /** Direct plus every descendant topic's documents. */
  totalDocumentCount: z.number().int().nonnegative(),
});
export type KnowledgeTopicNode = z.infer<typeof KnowledgeTopicNodeSchema>;

/** A document as listed or read from a mounted catalog (body excluded). */
export const KnowledgeDocumentSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  summary: z.string().nullable(),
  language: z.string(),
  topicId: z.string(),
  ordinal: z.number().int().nullable(),
  sourceUrl: z.string().nullable(),
  sourceRevision: z.string().nullable(),
  sourceUpdatedAt: z.string().nullable(),
  attribution: z.record(z.string(), z.string()).nullable(),
  meta: z.record(z.string(), z.unknown()).nullable(),
});
export type KnowledgeDocumentSummary = z.infer<typeof KnowledgeDocumentSummarySchema>;

export const KnowledgeDocumentPageSchema = z.object({
  documents: z.array(KnowledgeDocumentSummarySchema),
  total: z.number().int().nonnegative(),
});
export type KnowledgeDocumentPage = z.infer<typeof KnowledgeDocumentPageSchema>;

export const KnowledgeDocumentReadSchema = KnowledgeDocumentSummarySchema.extend({
  markdown: z.string(),
});
export type KnowledgeDocumentRead = z.infer<typeof KnowledgeDocumentReadSchema>;

/** One declared image asset of a mounted catalog. */
export const KnowledgeAssetInfoSchema = z.object({
  path: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: Sha256HexSchema,
});
export type KnowledgeAssetInfo = z.infer<typeof KnowledgeAssetInfoSchema>;

export const KnowledgeSearchRequestSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(50).optional(),
  /** Restrict to these catalog ids (default: every enabled catalog). */
  catalogs: z.array(KnowledgeIdSchema).optional(),
});
export type KnowledgeSearchRequest = z.infer<typeof KnowledgeSearchRequestSchema>;

// ── history events ──────────────────────────────────────────────────────────

export const KNOWLEDGE_HISTORY_KINDS = [
  'knowledge.catalog.installed',
  'knowledge.catalog.updated',
  'knowledge.catalog.enabled',
  'knowledge.catalog.disabled',
  'knowledge.catalog.removed',
  'knowledge.catalog.install_failed',
] as const;
export type KnowledgeHistoryKind = (typeof KNOWLEDGE_HISTORY_KINDS)[number];
