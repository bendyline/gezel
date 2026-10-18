import { z } from 'zod';
import { IdRegex } from './catalog-id.js';
import { LicenseClassSchema } from './catalog.js';

// ─ .gezmodel portable model bundles ──────────────────────────────────────
//
// A `.gezmodel` is a renamed ZIP containing a root `manifest.json`, the
// installed + catalog manifest snapshots Gezel used, and a `model/` folder
// with the model's data files. Every non-root entry is size- and SHA-256-
// pinned here so import can verify the complete archive before publishing a
// single byte into an engine's live model directory.

export const GezmodelEngineSchema = z.enum(['llama-cpp', 'mlx', 'ds4']);
export type GezmodelEngine = z.infer<typeof GezmodelEngineSchema>;

export const GezmodelFileSchema = z.object({
  /** POSIX-style path inside the ZIP (`model/foo.gguf`, `manifests/…`). */
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (path) =>
        !path.includes('\\') &&
        !path.includes('\0') &&
        !path.startsWith('/') &&
        path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
      'bundle path must be a contained POSIX-style relative path',
    ),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(['model', 'installed-manifest', 'catalog-manifest', 'catalog-file']),
});
export type GezmodelFile = z.infer<typeof GezmodelFileSchema>;

export const GezmodelLicenseSchema = z.object({
  name: z.string().min(1),
  shortName: z.string().min(1).optional(),
  class: LicenseClassSchema.optional(),
  url: z.string().url().optional(),
});
export type GezmodelLicense = z.infer<typeof GezmodelLicenseSchema>;

/** Root `manifest.json` wire format for `.gezmodel` v1. */
export const GezmodelBundleManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('gezel-model'),
  id: z.string().regex(IdRegex),
  name: z.string().min(1).max(256),
  engine: GezmodelEngineSchema,
  createdAt: z.string().datetime(),
  createdBy: z.literal('gezel'),
  catalogVersion: z.string().optional(),
  approxSizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  license: GezmodelLicenseSchema.optional(),
  files: z.array(GezmodelFileSchema).min(2).max(16_384),
});
export type GezmodelBundleManifest = z.infer<typeof GezmodelBundleManifestSchema>;

/** Result of the mandatory scan/stage phase, shown in the import review UI. */
export const GezmodelImportReviewSchema = z.object({
  importId: z.string().uuid(),
  manifest: GezmodelBundleManifestSchema,
  alreadyInstalled: z.boolean(),
  warnings: z.array(z.string()),
});
export type GezmodelImportReview = z.infer<typeof GezmodelImportReviewSchema>;

/** Live work reported while a `.gezmodel` bundle is staged and security-checked. */
export type GezmodelImportProgress =
  | { phase: 'receiving'; bytesCompleted: number; bytesTotal?: number }
  | { phase: 'inspecting' }
  | { phase: 'verifying'; bytesCompleted: number; bytesTotal: number }
  | { phase: 'validating' };

// ─ Private → shared model migration ─────────────────────────────────────
//
// A user daemon may discover complete models in its own writable store (or
// in one of Gezel's well-known per-user homes) while a machine engine broker
// owns the canonical shared store. The source is deliberately an enum rather
// than a filesystem path: callers cannot use this API to make the daemon read
// an arbitrary directory.

export const SharedModelMigrationSourceSchema = z.enum(['current', 'default', 'development']);
export type SharedModelMigrationSource = z.infer<typeof SharedModelMigrationSourceSchema>;

export const SharedModelMigrationCandidateSchema = z.object({
  source: SharedModelMigrationSourceSchema,
  sourceLabel: z.string().min(1).max(128),
  engine: GezmodelEngineSchema,
  id: z.string().regex(IdRegex),
  name: z.string().min(1).max(256),
  approxSizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  catalogVersion: z.string().min(1),
  /** The user daemon is currently copying and verifying this candidate. */
  moving: z.boolean().default(false),
});
export type SharedModelMigrationCandidate = z.infer<typeof SharedModelMigrationCandidateSchema>;

export const SharedModelMigrationCandidatesResponseSchema = z.object({
  available: z.boolean(),
  candidates: z.array(SharedModelMigrationCandidateSchema),
});
export type SharedModelMigrationCandidatesResponse = z.infer<
  typeof SharedModelMigrationCandidatesResponseSchema
>;

export const SharedModelMigrationRequestSchema = z.object({
  source: SharedModelMigrationSourceSchema,
  engine: GezmodelEngineSchema,
  id: z.string().regex(IdRegex),
});
export type SharedModelMigrationRequest = z.infer<typeof SharedModelMigrationRequestSchema>;

export const SharedModelMigrationResultSchema = z.object({
  ok: z.literal(true),
  engine: GezmodelEngineSchema,
  id: z.string().regex(IdRegex),
  localRemoved: z.boolean(),
  warning: z.string().min(1).optional(),
});
export type SharedModelMigrationResult = z.infer<typeof SharedModelMigrationResultSchema>;
