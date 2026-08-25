import { z } from 'zod';

/**
 * Knowledge catalogs — the wire/disk contracts for `.gezk` archives, the
 * per-user registry, the machine inventory, and the retrieval provenance
 * shapes. The format itself (DDL, sharding, routing, quantization,
 * determinism) is frozen in docs/gezk-format-v1.md; these schemas are its
 * type-level expression and are shared by the compiler
 * (@bendyline/gezel-knowledge), the daemon, the broker, the CLI, and the UI.
 *
 * Version discipline: `formatVersion` governs the container layout,
 * `indexSchemaVersion` the SQLite DDL. Readers never migrate a catalog —
 * incompatibility is a typed disabled-with-reason state, and a publisher's
 * signed artifact is never rewritten.
 */

// ── id grammars (frozen in gezk-format-v1.md §7) ────────────────────────────

/** DNS-label style: publishers, catalogs, topics. */
export const KNOWLEDGE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export const KnowledgeIdSchema = z.string().regex(KNOWLEDGE_ID_PATTERN);

/**
 * Portable, single-directory catalog version. Versions are identities, not
 * paths: separators, drive/ADS syntax, controls, dot segments, trailing dots
 * or spaces, and Windows device names are all rejected on every platform.
 */
export const KNOWLEDGE_VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,126}[A-Za-z0-9])?$/;
export const KnowledgeVersionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(KNOWLEDGE_VERSION_PATTERN, 'catalog version must be one portable path segment')
  .refine(
    (value) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),
    'catalog version must not use a reserved Windows device name',
  );

/** 1–256 Unicode scalars, NFC, no controls, trimmed. Wikipedia = decimal curid. */
export const KnowledgeDocumentIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => s === s.normalize('NFC'), 'document id must be NFC-normalized')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control-character ban is the point
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f]/u.test(s), 'document id must not contain controls')
  .refine((s) => s === s.trim(), 'document id must not have leading/trailing whitespace');

/** Exactly 32 lowercase hex chars (first 16 bytes of the chunk-uid hash). */
export const KnowledgeChunkUidSchema = z.string().regex(/^[0-9a-f]{32}$/);

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

// ── embedding + chunking profiles ───────────────────────────────────────────

export const KnowledgeVectorEncodingSchema = z.enum(['bit384+int8']);

/**
 * The FULL vector-space identity of a catalog's embeddings. Matching only a
 * model name or a dimension is unsafe — two 384-dim models do not share a
 * space, and an instruction-prefix change silently changes vectors. Readers
 * compare the entire object (by `id`, with the rest as the id's definition).
 */
export const KnowledgeEmbeddingProfileSchema = z.object({
  /** e.g. `gezel-multilingual-e5-small@1`. New encoding/model = new id. */
  id: z.string().min(1),
  model: z.object({
    repo: z.string().min(1),
    revision: z.string().min(1),
    onnxDigest: z.string().optional(),
  }),
  tokenizer: z.object({
    kind: z.string().min(1),
    digest: z.string().optional(),
  }),
  pooling: z.literal('mean'),
  normalized: z.literal(true),
  dimensions: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  queryInstruction: z.string(),
  passageInstruction: z.string(),
  vectorEncoding: KnowledgeVectorEncodingSchema,
  distance: z.object({
    stage1: z.literal('hamming'),
    stage2: z.literal('cosine'),
  }),
  quantization: z.object({
    int8: z.object({
      method: z.literal('symmetric-linear'),
      scale: z.literal(127),
    }),
    binary: z.object({
      method: z.literal('sign'),
      threshold: z.literal(0),
      packing: z.literal('lsb-first'),
    }),
  }),
});
export type KnowledgeEmbeddingProfile = z.infer<typeof KnowledgeEmbeddingProfileSchema>;

export const KnowledgeChunkingProfileSchema = z.object({
  /** `gezel-markdown-chunks@2` for knowledge; `@1` names the project chunker. */
  id: z.string().min(1),
  unit: z.literal('tokens'),
  tokenizer: z.literal('profile'),
  targetTokens: z.number().int().positive(),
  overlapTokens: z.number().int().nonnegative(),
  contextHeader: z.object({ maxTokens: z.number().int().nonnegative() }),
});
export type KnowledgeChunkingProfile = z.infer<typeof KnowledgeChunkingProfileSchema>;

// ── manifest ────────────────────────────────────────────────────────────────

export const KnowledgeManifestFileSchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: Sha256HexSchema,
});

export const KnowledgeCatalogManifestSchema = z.object({
  kind: z.literal('gezel-knowledge-catalog'),
  formatVersion: z.literal(1),
  indexSchemaVersion: z.literal(1),
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
    noticePath: z.string().optional(),
    attributionRequired: z.boolean(),
  }),
  embedding: KnowledgeEmbeddingProfileSchema,
  chunking: KnowledgeChunkingProfileSchema,
  topics: z
    .array(z.object({ id: KnowledgeIdSchema, name: z.string().min(1) }))
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
  }),
  files: z.array(KnowledgeManifestFileSchema).min(1),
  compatibility: z.object({
    minimumGezelVersion: z.string().optional(),
    maximumIndexSchemaVersion: z.number().int().positive(),
  }),
  smokeQueries: z
    .array(
      z.object({
        query: z.string().min(1),
        expectedDocumentIds: z.array(KnowledgeDocumentIdSchema).min(1),
      }),
    )
    .optional(),
  toolchain: z
    .object({
      compiler: z.string(),
      node: z.string(),
      sqlite: z.string().optional(),
      sqliteVec: z.string().optional(),
      onnxruntime: z.string().optional(),
      platform: z.string(),
      modelDigest: z.string().optional(),
      tokenizerDigest: z.string().optional(),
    })
    .optional(),
  signature: z
    .object({
      algorithm: z.literal('ed25519'),
      keyId: z.string().min(1),
      canonicalization: z.literal('rfc8785'),
      value: z.string().min(1),
    })
    .optional(),
});
export type KnowledgeCatalogManifest = z.infer<typeof KnowledgeCatalogManifestSchema>;

// ── compiler input ──────────────────────────────────────────────────────────

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

// ── the immutable catalog reference + user registry ─────────────────────────

export const KnowledgeStorageScopeSchema = z.enum(['machine-shared', 'user']);
export type KnowledgeStorageScope = z.infer<typeof KnowledgeStorageScopeSchema>;

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

// ── knowledge:// URI ────────────────────────────────────────────────────────

export interface KnowledgeUri {
  catalogId: string;
  documentId: string;
  fragment?: { chunk: string } | { lineStart: number; lineEnd?: number };
}

const KNOWLEDGE_URI_PREFIX = 'knowledge://';

/** Format per the frozen ABNF in gezk-format-v1.md §8. */
export function formatKnowledgeUri(uri: KnowledgeUri): string {
  const encodedDoc = uri.documentId
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  let out = `${KNOWLEDGE_URI_PREFIX}${uri.catalogId}/${encodedDoc}`;
  if (uri.fragment) {
    out +=
      'chunk' in uri.fragment
        ? `#chunk=${uri.fragment.chunk}`
        : `#line=${uri.fragment.lineStart}${uri.fragment.lineEnd !== undefined ? `-${uri.fragment.lineEnd}` : ''}`;
  }
  return out;
}

/** Strict parse; null for anything that is not a well-formed knowledge URI. */
export function parseKnowledgeUri(raw: string): KnowledgeUri | null {
  if (!raw.startsWith(KNOWLEDGE_URI_PREFIX)) return null;
  const rest = raw.slice(KNOWLEDGE_URI_PREFIX.length);
  const hashAt = rest.indexOf('#');
  const body = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const fragmentRaw = hashAt === -1 ? null : rest.slice(hashAt + 1);

  const slashAt = body.indexOf('/');
  if (slashAt <= 0) return null;
  const catalogId = body.slice(0, slashAt);
  const encodedDoc = body.slice(slashAt + 1);
  if (!KNOWLEDGE_ID_PATTERN.test(catalogId)) return null;
  if (!encodedDoc || encodedDoc.length > 512) return null;

  let documentId: string;
  try {
    documentId = encodedDoc
      .split('/')
      .map((seg) => {
        if (!seg) throw new Error('empty segment');
        return decodeURIComponent(seg);
      })
      .join('/');
  } catch {
    return null;
  }
  if (!KnowledgeDocumentIdSchema.safeParse(documentId).success) return null;

  if (fragmentRaw === null) return { catalogId, documentId };
  const chunkMatch = /^chunk=([0-9a-f]{32})$/.exec(fragmentRaw);
  if (chunkMatch) return { catalogId, documentId, fragment: { chunk: chunkMatch[1] as string } };
  const lineMatch = /^line=(\d+)(?:-(\d+))?$/.exec(fragmentRaw);
  if (lineMatch) {
    return {
      catalogId,
      documentId,
      fragment: {
        lineStart: Number.parseInt(lineMatch[1] as string, 10),
        ...(lineMatch[2] !== undefined ? { lineEnd: Number.parseInt(lineMatch[2], 10) } : {}),
      },
    };
  }
  return null;
}

// ── the signed publisher registry (CDN `_knowledge/registry/index.json`) ────

/** One downloadable catalog release a publisher's registry advertises. */
export const KnowledgeRegistryEntrySchema = z.object({
  catalogId: KnowledgeIdSchema,
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  language: z.string().min(2),
  documents: z.number().int().nonnegative(),
  /** Size of the `.gezk` archive itself (download accounting/preflight). */
  archiveBytes: z.number().int().nonnegative(),
  /** sha256 of the `.gezk` archive — the ref's contentDigest after install. */
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Absolute download URL. Uploaded before the registry that names it. */
  url: z.string().url(),
  license: z.object({ name: z.string().min(1), attributionRequired: z.boolean() }),
  sourceSnapshot: z
    .object({ name: z.string(), date: z.string(), taxonomyVersion: z.string().optional() })
    .optional(),
});
export type KnowledgeRegistryEntry = z.infer<typeof KnowledgeRegistryEntrySchema>;

/**
 * The publisher registry document. Signed exactly like a catalog manifest:
 * Ed25519 over the RFC 8785 canonical form minus `signature`, verified
 * against shipped keyId-indexed trust anchors. Published LAST — every
 * archive it names must already be live, so a half-published release is
 * invisible rather than broken, and withdrawing a release is deleting its
 * row and re-signing (installed catalogs are never affected).
 */
export const KnowledgeRegistryIndexSchema = z.object({
  kind: z.literal('gezel-knowledge-registry'),
  formatVersion: z.literal(1),
  publisher: z.object({
    id: KnowledgeIdSchema,
    name: z.string().min(1),
    url: z.string().optional(),
  }),
  generatedAt: z.string(),
  catalogs: z.array(KnowledgeRegistryEntrySchema),
  signature: z
    .object({
      algorithm: z.literal('ed25519'),
      keyId: z.string().min(1),
      canonicalization: z.literal('rfc8785'),
      value: z.string().min(1),
    })
    .optional(),
});
export type KnowledgeRegistryIndex = z.infer<typeof KnowledgeRegistryIndexSchema>;

/**
 * One available upgrade: an installed catalog for which the signed registry
 * offers a strictly newer version. `contentDigest`/`url`/`archiveBytes` come
 * from the verified registry row — exactly what the install endpoint needs
 * to run the hardened URL install.
 */
export const KnowledgeUpdateCandidateSchema = z.object({
  publisherId: KnowledgeIdSchema,
  catalogId: KnowledgeIdSchema,
  name: z.string(),
  installedVersion: z.string(),
  availableVersion: z.string(),
  archiveBytes: z.number().int().nonnegative(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.string().url(),
});
export type KnowledgeUpdateCandidate = z.infer<typeof KnowledgeUpdateCandidateSchema>;

export const KnowledgeUpdatesResponseSchema = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(false),
    reason: z.enum(['no-registry-url', 'network-blocked', 'no-trust-anchors', 'fetch-failed']),
    detail: z.string().optional(),
  }),
  z.object({
    available: z.literal(true),
    registryUrl: z.string(),
    publisher: z.object({ id: KnowledgeIdSchema, name: z.string() }),
    checkedAt: z.string(),
    updates: z.array(KnowledgeUpdateCandidateSchema),
  }),
]);
export type KnowledgeUpdatesResponse = z.infer<typeof KnowledgeUpdatesResponseSchema>;

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
  ]),
});
export type KnowledgeInstallRequest = z.infer<typeof KnowledgeInstallRequestSchema>;

export const UpdateKnowledgeCatalogRequestSchema = z.object({
  enabled: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
});
export type UpdateKnowledgeCatalogRequest = z.infer<typeof UpdateKnowledgeCatalogRequestSchema>;

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
