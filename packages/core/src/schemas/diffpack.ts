import { z } from 'zod';

/**
 * Diffpacks — a bundle of proposed file edits a gezel drafted but never
 * applied. The pack lives in the project's artifacts drawer; the workspace is
 * untouched until the *user* clicks Apply. That inversion is the point: it
 * lets a developer gezel work on a folder gezels have no write grant for, and
 * it lets the night shift produce work the user reviews in the morning instead
 * of waking up to a mutated tree.
 *
 * On-disk layout (artifacts-relative), one folder per pack:
 *
 *   diffpacks/<packId>/after/<workspace path>   copy-on-write draft tree
 *   diffpacks/<packId>/files/<nn>-<slug>.diff   sealed single-file unified diffs
 *   diffpacks/<packId>/notes.md                 the gezel's explanation
 *   diffpacks/<packId>/manifest.json            pack metadata (also the export payload)
 *
 * `after/` and `files/` are machine-owned (see `isReservedDiffpackArtifactPath`)
 * so a model cannot forge a diff it never drafted by calling `write_artifact`.
 *
 * `packId` is always the `num` of the task that drafted it — including a
 * fanout shard, which has its own number. Unique per project, nothing to
 * mint, and no second numbering scheme running alongside `BW-n`. It is shown
 * as `DP-<packId>`.
 */

/** Canonical display form of a pack id. */
export function formatDiffpackRef(packId: string): string {
  return `DP-${packId}`;
}

/**
 * `packId` doubles as a path segment under the artifacts drawer, so it is
 * restricted to the shapes the runtime mints rather than accepting free text.
 */
export const DiffpackIdSchema = z.string().regex(/^[1-9]\d*$/);

/**
 * Persisted lifecycle. Drift and overlap are deliberately NOT here — both are
 * projections of the current workspace and the sibling packs, so they are
 * computed at read time (the same call the Boekwachter issue's `stale` bit
 * makes). Persisting them would mean every external edit needs a writer.
 */
export const DiffpackStatusSchema = z.enum([
  /** The task is still drafting into `after/`; no diffs sealed yet. */
  'drafting',
  /** Sealed and reviewable. */
  'ready',
  /** Every file applied cleanly. */
  'applied',
  /** A file subset was applied; the rest remain proposed. */
  'partially-applied',
  /** Drafting ended without a usable change set (canceled task, empty draft). */
  'failed',
  /** The user rejected it. */
  'dismissed',
]);
export type DiffpackStatus = z.infer<typeof DiffpackStatusSchema>;

/** Statuses that still hold a claim on their source issues and their files. */
export const ACTIVE_DIFFPACK_STATUSES: readonly DiffpackStatus[] = ['drafting', 'ready'];

export function isActiveDiffpackStatus(status: DiffpackStatus): boolean {
  return ACTIVE_DIFFPACK_STATUSES.includes(status);
}

export const DiffpackOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('boekwachter-issue'),
    /** Display refs (`BW-8`) of the issues this pack was drafted to close. */
    issueRefs: z.array(z.string()).min(1),
  }),
  z.object({ kind: z.literal('manual') }),
]);
export type DiffpackOrigin = z.infer<typeof DiffpackOriginSchema>;

export const DiffpackFileChangeSchema = z.enum(['modify', 'add', 'delete']);
export type DiffpackFileChange = z.infer<typeof DiffpackFileChangeSchema>;

export const DiffpackFileSchema = z.object({
  /** Workspace-relative target. */
  path: z.string().min(1),
  /**
   * Artifacts-relative sidecar holding this file's unified diff. Empty for a
   * `delete`, which has no diff: a patch that removes every line applies, but
   * it leaves an empty file rather than removing it.
   */
  diffArtifact: z.string(),
  /**
   * sha256 of the workspace file at seal time — empty string for an `add`.
   * The apply precondition compares it to the file's current hash so a
   * drifted pack is explained before `applyPatch` rejects a hunk.
   */
  baseHash: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  change: DiffpackFileChangeSchema,
});
export type DiffpackFile = z.infer<typeof DiffpackFileSchema>;

/** One row of `~/.gezel/projects/{id}/diffpacks.json`. */
export const DiffpackRecordSchema = z.object({
  packId: DiffpackIdSchema,
  projectId: z.string().min(1),
  title: z.string().min(1),
  /** One or two sentences pulled from the gezel's notes; may be empty while drafting. */
  summary: z.string(),
  status: DiffpackStatusSchema,
  origin: DiffpackOriginSchema,
  /** The drafting task, as `{projectId}/{num}`. */
  taskRef: z.string().min(1),
  gezelId: z.string().optional(),
  gezelName: z.string().optional(),
  /** Night-shift window key that produced it, when it came from the night shift. */
  windowKey: z.string().optional(),
  files: z.array(DiffpackFileSchema),
  /** Artifacts-relative. */
  notesPath: z.string(),
  manifestPath: z.string(),
  createdAt: z.string(),
  sealedAt: z.string().optional(),
  appliedAt: z.string().optional(),
  /** Status `failed` only — why sealing produced nothing usable. */
  error: z.string().optional(),
  /** Per-file outcome of the last apply. */
  results: z
    .array(z.object({ path: z.string(), ok: z.boolean(), error: z.string().optional() }))
    .optional(),
});
export type DiffpackRecord = z.infer<typeof DiffpackRecordSchema>;

/** Another active pack that also touches one of this pack's files. */
export const DiffpackOverlapSchema = z.object({
  path: z.string(),
  packIds: z.array(DiffpackIdSchema).min(1),
});
export type DiffpackOverlap = z.infer<typeof DiffpackOverlapSchema>;

/** Wire shape: the record plus the read-time projections. */
export const DiffpackSchema = DiffpackRecordSchema.extend({
  /** Files whose current workspace hash no longer matches `baseHash`. */
  drifted: z.array(z.string()),
  overlaps: z.array(DiffpackOverlapSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Live task fields, best-effort. */
  taskStatus: z.enum(['draft', 'paused', 'active', 'complete', 'canceled']).optional(),
  needsAttention: z.boolean().optional(),
});
export type Diffpack = z.infer<typeof DiffpackSchema>;

/** Compact row for the night review and other summary surfaces. */
export const DiffpackSummarySchema = z.object({
  packId: DiffpackIdSchema,
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  status: DiffpackStatusSchema,
  fileCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  issueRefs: z.array(z.string()),
  drifted: z.boolean(),
});
export type DiffpackSummary = z.infer<typeof DiffpackSummarySchema>;

/* ─── Wire ────────────────────────────────────────────────────────────── */

export const ListDiffpacksResponseSchema = z.object({
  diffpacks: z.array(DiffpackSchema),
});
export type ListDiffpacksResponse = z.infer<typeof ListDiffpacksResponseSchema>;

export const DiffpackResponseSchema = z.object({
  diffpack: DiffpackSchema,
  /** The gezel's notes markdown, inlined so the review pane is one round trip. */
  notes: z.string(),
});
export type DiffpackResponse = z.infer<typeof DiffpackResponseSchema>;

export const ApplyDiffpackRequestSchema = z.object({
  /** Omit to apply every file in the pack. */
  paths: z.array(z.string().min(1)).optional(),
  /**
   * Apply even though one or more targets drifted since the pack was sealed.
   * The patch still has to apply cleanly — this only waives the hash
   * precondition, it never forces a rejected hunk through.
   */
  allowDrifted: z.boolean().optional(),
});
export type ApplyDiffpackRequest = z.infer<typeof ApplyDiffpackRequestSchema>;

export const ApplyDiffpackResponseSchema = z.object({
  ok: z.boolean(),
  diffpack: DiffpackSchema,
  results: z.array(z.object({ path: z.string(), ok: z.boolean(), error: z.string().optional() })),
});
export type ApplyDiffpackResponse = z.infer<typeof ApplyDiffpackResponseSchema>;

export const DismissDiffpackResponseSchema = z.object({
  ok: z.literal(true),
  diffpack: DiffpackSchema,
});
export type DismissDiffpackResponse = z.infer<typeof DismissDiffpackResponseSchema>;

/**
 * The `manifest.json` written into the pack folder. Self-contained on purpose:
 * it is what the zip export carries, so someone who unzips it outside gezel
 * still knows which file each diff targets and what it was drafted against.
 */
export const DiffpackManifestSchema = z.object({
  version: z.literal(1),
  packId: DiffpackIdSchema,
  projectId: z.string(),
  title: z.string(),
  summary: z.string(),
  origin: DiffpackOriginSchema,
  createdAt: z.string(),
  sealedAt: z.string().optional(),
  gezelName: z.string().optional(),
  files: z.array(DiffpackFileSchema),
  /**
   * Paths the gezel proposed deleting. Kept out of `files` because a deletion
   * has no diff sidecar — a unified diff that removes every line would apply,
   * but it would leave an empty file rather than removing it.
   */
  deletions: z.array(z.string()),
});
export type DiffpackManifest = z.infer<typeof DiffpackManifestSchema>;
