import { z } from 'zod';
import { KnowledgeIdSchema, Sha256HexSchema } from './ids.js';
import { GEZK_REGISTRY_KIND, KnowledgeSignatureSchema } from './manifest.js';

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
  contentDigest: Sha256HexSchema,
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
 * against keyId-indexed trust anchors. Published LAST — every archive it
 * names must already be live, so a half-published release is invisible
 * rather than broken, and withdrawing a release is deleting its row and
 * re-signing (installed catalogs are never affected).
 */
export const KnowledgeRegistryIndexSchema = z.object({
  kind: z.literal(GEZK_REGISTRY_KIND),
  formatVersion: z.literal('0.5'),
  publisher: z.object({
    id: KnowledgeIdSchema,
    name: z.string().min(1),
    url: z.string().optional(),
  }),
  generatedAt: z.string(),
  catalogs: z.array(KnowledgeRegistryEntrySchema),
  signature: KnowledgeSignatureSchema.optional(),
});
export type KnowledgeRegistryIndex = z.infer<typeof KnowledgeRegistryIndexSchema>;
