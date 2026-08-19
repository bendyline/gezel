import { z } from 'zod';

/**
 * Storage cleanup, backup, and restore — the explicit "reclaim space before
 * you uninstall" surface. Uninstall itself cannot adjudicate `~/.gezel`: an
 * npm uninstall gets no hook at all, and the Windows and Linux installers
 * deliberately preserve the home directory. Without this, a user who removes
 * Gezel strands every model they ever downloaded.
 *
 * The classification is what makes the choice safe to offer. Re-downloadable
 * content is the class we steer people toward — deleting it costs bandwidth,
 * not work. User content is a separate, deliberately gated decision.
 */

export const StorageClassSchema = z.enum([
  /** Models, engines, toolsets, caches. Deleting costs a re-download. */
  'redownloadable',
  /** Gezels, projects, documents, settings. Deleting destroys work. */
  'user-content',
  /**
   * Runtime handshake state, transaction journals, logs. Never offered for
   * deletion and never backed up — it is rebuilt or irrelevant by the next
   * boot.
   */
  'ephemeral',
  /**
   * The extracted service bundle and the pinned node/pnpm runtimes. The
   * daemon executes from these, so it must not delete them out from under
   * itself; the platform uninstaller owns them and the supervisor
   * re-extracts on a sentinel mismatch. Reported for accounting only.
   */
  'uninstaller-owned',
]);
export type StorageClass = z.infer<typeof StorageClassSchema>;

export const StorageCategoryIdSchema = z.enum([
  'models',
  'native-engines',
  'engine-caches',
  'toolsets',
  'gilde-cache',
  'derived-caches',
  'service-bundle',
  'runtimes',
  'gezels',
  'projects',
  'documents',
  'settings',
  'secrets',
  'folder-backups',
  'git-clones',
]);
export type StorageCategoryId = z.infer<typeof StorageCategoryIdSchema>;

/** One addressable thing inside a category — a single model, gezel, or project. */
export const StorageItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  bytes: z.number(),
  /**
   * True when this item resolves outside `~/.gezel` — an externalized folder
   * scope or a project pointed at a real working directory. Cleanup refuses
   * these, and their bytes are not measured or included in storage totals.
   */
  external: z.boolean(),
  /** Set when the item cannot be deleted, explaining why. */
  blockedReason: z.string().optional(),
});
export type StorageItem = z.infer<typeof StorageItemSchema>;

export const StorageCategorySchema = z.object({
  id: StorageCategoryIdSchema,
  class: StorageClassSchema,
  label: z.string(),
  description: z.string(),
  bytes: z.number(),
  itemCount: z.number(),
  /** False for `uninstaller-owned` and anything held back from v1 cleanup. */
  deletable: z.boolean(),
  /** Whether this category's content is written into a content backup. */
  inBackup: z.boolean(),
  /** Paths outside the home. Bytes are zero because storage accounting does not measure them. */
  external: z.array(z.object({ path: z.string(), bytes: z.number() })),
  /** Populated for item-granular categories (models, gezels, projects). */
  items: z.array(StorageItemSchema).optional(),
});
export type StorageCategory = z.infer<typeof StorageCategorySchema>;

export const StorageSummarySchema = z.object({
  home: z.string(),
  categories: z.array(StorageCategorySchema),
  /** Sum over locally stored `redownloadable` categories — the "safe to reclaim" headline. */
  redownloadableBytes: z.number(),
  /** Sum over `user-content` categories stored inside this Gezel home. */
  userContentBytes: z.number(),
  /** ISO timestamp of the walk these numbers came from. */
  measuredAt: z.string(),
});
export type StorageSummary = z.infer<typeof StorageSummarySchema>;

export const CleanupRequestSchema = z.object({
  categories: z.array(StorageCategoryIdSchema).min(1),
  /** Restrict a category to specific items; omit to take the whole category. */
  itemIds: z.partialRecord(StorageCategoryIdSchema, z.array(z.string())).optional(),
  /**
   * Required whenever any requested category is `user-content`. The server
   * rejects the request without it — a UI bug must not be able to delete a
   * person's gezels by omission.
   */
  confirmUserContent: z.boolean().optional(),
});
export type CleanupRequest = z.infer<typeof CleanupRequestSchema>;

export const StorageJobKindSchema = z.enum(['cleanup', 'backup', 'restore']);
export type StorageJobKind = z.infer<typeof StorageJobKindSchema>;

export const StorageJobStatusSchema = z.enum(['queued', 'running', 'done', 'error', 'cancelled']);
export type StorageJobStatus = z.infer<typeof StorageJobStatusSchema>;

export const StorageJobPhaseSchema = z.enum([
  /** Unload live models/providers so their files are not held open. */
  'quiesce',
  'delete',
  'scan',
  'write',
  'extract',
  'publish',
  /** Re-run `ensureLayout` so the next boot starts from a sane tree. */
  'verify-recovery',
]);
export type StorageJobPhase = z.infer<typeof StorageJobPhaseSchema>;

export const StorageJobSchema = z.object({
  id: z.string(),
  kind: StorageJobKindSchema,
  status: StorageJobStatusSchema,
  phase: StorageJobPhaseSchema.optional(),
  /** Human-readable label for what is being worked on right now. */
  currentLabel: z.string().optional(),
  itemsDone: z.number(),
  totalItems: z.number(),
  /** Freed by cleanup, written by backup, extracted by restore. */
  bytesDone: z.number(),
  totalBytes: z.number(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  error: z.string().optional(),
  /** Set when config or Store-cached state changed underneath the daemon. */
  restartRequired: z.boolean(),
  cancelRequested: z.boolean(),
  /** Paths deliberately left alone because they live outside `~/.gezel`. */
  skippedExternal: z.array(z.object({ label: z.string(), path: z.string() })),
});
export type StorageJob = z.infer<typeof StorageJobSchema>;

export const BackupItemKindSchema = z.enum([
  'gezel',
  'project',
  /**
   * The shared document library. It is the workspace of the canonical shared
   * project, but it archives under its own kind so a restore lands content in
   * whatever shared project the target install booted with, instead of
   * creating a second one.
   */
  'document-root',
  'settings-file',
]);
export type BackupItemKind = z.infer<typeof BackupItemKindSchema>;

export const BackupPlanItemSchema = z.object({
  kind: BackupItemKindSchema,
  id: z.string(),
  label: z.string(),
  bytes: z.number(),
  fileCount: z.number(),
  /** True when the source content lives outside `~/.gezel`. Backed up anyway
   *  — reading an external folder is safe; only deletion is restricted. */
  external: z.boolean(),
});
export type BackupPlanItem = z.infer<typeof BackupPlanItemSchema>;

export const BackupPlanSchema = z.object({
  items: z.array(BackupPlanItemSchema),
  totalBytes: z.number(),
  /** Always true: device-bound credentials never enter a portable archive. */
  secretsExcluded: z.literal(true),
  warnings: z.array(z.string()),
  /** Free bytes at the destination, when one was supplied. */
  destFreeBytes: z.number().optional(),
});
export type BackupPlan = z.infer<typeof BackupPlanSchema>;

export const BackupRequestSchema = z.object({
  /** Absolute path the daemon writes the archive to. */
  outPath: z.string(),
  /** Omit to back up everything in the plan. */
  include: z
    .object({
      gezels: z.array(z.string()).optional(),
      projects: z.array(z.string()).optional(),
      documents: z.boolean().optional(),
      settings: z.boolean().optional(),
    })
    .optional(),
  /** Skip project `workspace/` trees — the escape hatch for multi-GB repos. */
  excludeWorkspaces: z.boolean().optional(),
});
export type BackupRequest = z.infer<typeof BackupRequestSchema>;

export const BACKUP_MANIFEST_KIND = 'gezel-backup';
export const BACKUP_SCHEMA_VERSION = 1;

export const BackupManifestSchema = z.object({
  schemaVersion: z.number(),
  kind: z.literal(BACKUP_MANIFEST_KIND),
  createdAt: z.string(),
  gezelVersion: z.string(),
  platform: z.string(),
  /**
   * The source install's external folder configuration, recorded for
   * diagnosis only. Restore never applies it: another machine's paths are
   * meaningless here and pointing a fresh install at them would be worse
   * than useless.
   */
  externalFolders: z
    .object({
      documents: z.string().optional(),
      gezels: z.string().optional(),
      projects: z.string().optional(),
    })
    .nullable(),
  items: z.array(
    z.object({
      kind: BackupItemKindSchema,
      id: z.string(),
      label: z.string(),
      /** Path prefix inside the archive holding this item's files. */
      entryPrefix: z.string(),
      bytes: z.number(),
      fileCount: z.number(),
    }),
  ),
  secretsExcluded: z.literal(true),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export const RestoreScanRequestSchema = z.object({
  /** Absolute path to a `.zip` produced by the backup flow. */
  path: z.string(),
});
export type RestoreScanRequest = z.infer<typeof RestoreScanRequestSchema>;

export const RestoreConflictSchema = z.enum(['none', 'exists']);
export type RestoreConflict = z.infer<typeof RestoreConflictSchema>;

export const RestoreReviewItemSchema = z.object({
  kind: BackupItemKindSchema,
  id: z.string(),
  label: z.string(),
  bytes: z.number(),
  fileCount: z.number(),
  conflict: RestoreConflictSchema,
});
export type RestoreReviewItem = z.infer<typeof RestoreReviewItemSchema>;

export const RestoreReviewSchema = z.object({
  restoreId: z.string(),
  createdAt: z.string(),
  /** Version of the install that produced the archive. */
  gezelVersion: z.string(),
  archivePath: z.string(),
  items: z.array(RestoreReviewItemSchema),
  secretsExcluded: z.literal(true),
  warnings: z.array(z.string()),
});
export type RestoreReview = z.infer<typeof RestoreReviewSchema>;

export const RestoreConfirmSchema = z.object({
  items: z.array(
    z.object({
      kind: BackupItemKindSchema,
      id: z.string(),
      /** `replace` is the only way past an `exists` conflict. */
      action: z.enum(['add', 'replace']),
    }),
  ),
  /** Merge the archive's settings files. `externalFolders` is never applied. */
  settings: z.boolean().optional(),
});
export type RestoreConfirm = z.infer<typeof RestoreConfirmSchema>;
