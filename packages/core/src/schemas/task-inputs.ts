import { z } from 'zod';

/**
 * Craftbook inputs — the files a run works ON, declared by the book and
 * supplied at launch. See docs/craftbook-inputs.md for the full contract.
 *
 * A `folder` input is a set of files delivered as one folder (a picked
 * folder, or loose files the user chose together); a `file` input is exactly
 * one file. Either way the resolved value is one drawer-relative path, so a
 * book's `{{param}}` interpolates like any other string param.
 */
export const CRAFTBOOK_INPUT_KINDS = ['file', 'folder'] as const;
export const CraftbookInputKindSchema = z.enum(CRAFTBOOK_INPUT_KINDS);
export type CraftbookInputKind = z.infer<typeof CraftbookInputKindSchema>;

/**
 * The `input` annotation on one `paramSchema` property:
 *
 *   "source": { "type": "string", "input": { "kind": "folder", "accept": [".md", ".docx"] } }
 *
 * `maxFiles`/`maxBytes` may only tighten the runtime ceilings, never raise
 * them — see `effectiveInputLimits`.
 */
export const CraftbookParamInputSchema = z.object({
  kind: CraftbookInputKindSchema,
  /** Lower-case extensions with a leading dot. Absent → any file. */
  accept: z
    .array(z.string().regex(/^\.[a-z0-9][a-z0-9._-]*$/i, 'extensions look like ".md"'))
    .min(1)
    .optional(),
  maxFiles: z.number().int().positive().optional(),
  maxBytes: z.number().int().positive().optional(),
});
export type CraftbookParamInput = z.infer<typeof CraftbookParamInputSchema>;

/** Which drawer holds a resolved input. */
export const TaskInputDrawerSchema = z.enum(['workspace', 'artifacts']);
export type TaskInputDrawer = z.infer<typeof TaskInputDrawerSchema>;

/** Opaque id of an upload staging area. */
export const InputStagingIdSchema = z.string().regex(/^stg-[a-z0-9]{8,48}$/);

/**
 * How a launch supplies one input. Workspace and artifacts sources are read
 * where they are; an upload is adopted from its staging area into the task's
 * own `inputs/` folder.
 */
export const TaskInputSourceSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('workspace'), path: z.string() }),
  z.object({ from: z.literal('artifacts'), path: z.string().min(1) }),
  z.object({ from: z.literal('upload'), stagingId: InputStagingIdSchema }),
]);
export type TaskInputSource = z.infer<typeof TaskInputSourceSchema>;
export type TaskInputOrigin = TaskInputSource['from'];

/** The resolved input, stamped on the task at create. */
export const TaskInputRecordSchema = z.object({
  kind: CraftbookInputKindSchema,
  drawer: TaskInputDrawerSchema,
  /**
   * Drawer-relative path of the folder or file; `.` is the workspace root —
   * never empty, because an empty `{{param}}` reads as a dead branch to the
   * prompt's first-action guard.
   */
  path: z.string(),
  from: z.enum(['workspace', 'artifacts', 'upload']),
  /** Display name only — a folder or file name, never an absolute host path. */
  label: z.string(),
  /** Artifacts-relative path of the manifest listing every accepted file. */
  manifest: z.string(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  /** At least one accepted file is an office document needing conversion. */
  hasOfficeDocuments: z.boolean().optional(),
});
export type TaskInputRecord = z.infer<typeof TaskInputRecordSchema>;

export const TaskInputSkipReasonSchema = z.enum([
  'not-accepted',
  'sync-junk',
  'too-large',
  'over-file-limit',
  'over-byte-limit',
  'unreadable',
]);
export type TaskInputSkipReason = z.infer<typeof TaskInputSkipReasonSchema>;

/**
 * `tasks/<num>/inputs/<param>.json`. Always in the artifacts drawer, whatever
 * drawer holds the files, because the workspace may be read-only. `files` is
 * shaped to double as a fanout source:
 * `spawn: { overFile: "{{task.dir}}/inputs/source.json", overArtifact: true, itemsPath: "files" }`.
 */
export const TaskInputManifestSchema = z.object({
  param: z.string(),
  kind: CraftbookInputKindSchema,
  drawer: TaskInputDrawerSchema,
  path: z.string(),
  from: z.enum(['workspace', 'artifacts', 'upload']),
  label: z.string(),
  createdAt: z.string(),
  totalBytes: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      /** Drawer-relative — open it with the drawer's own read tool. */
      path: z.string(),
      name: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  skipped: z.array(z.object({ path: z.string(), reason: TaskInputSkipReasonSchema })),
});
export type TaskInputManifest = z.infer<typeof TaskInputManifestSchema>;

/** Dry-run of one input before launch, for the launcher's "37 files" line. */
export const TaskInputPreviewRequestSchema = z.object({
  craftbookId: z.string().min(1),
  craftbookVersion: z.string().optional(),
  param: z.string().min(1),
  source: TaskInputSourceSchema,
});
export type TaskInputPreviewRequest = z.infer<typeof TaskInputPreviewRequestSchema>;

export const TaskInputPreviewResponseSchema = z.object({
  kind: CraftbookInputKindSchema,
  drawer: TaskInputDrawerSchema,
  path: z.string(),
  label: z.string(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  skipped: z.array(z.object({ path: z.string(), reason: TaskInputSkipReasonSchema })),
  /** Set instead of counts when the source cannot be used as-is. */
  error: z.string().optional(),
});
export type TaskInputPreviewResponse = z.infer<typeof TaskInputPreviewResponseSchema>;

export const CreateInputStagingRequestSchema = z.object({
  craftbookId: z.string().min(1),
  craftbookVersion: z.string().optional(),
  param: z.string().min(1),
  /** The picked folder's or file's display name. */
  label: z.string().max(200).optional(),
});
export type CreateInputStagingRequest = z.infer<typeof CreateInputStagingRequestSchema>;

export const InputStagingLimitsSchema = z.object({
  kind: CraftbookInputKindSchema,
  accept: z.array(z.string()).optional(),
  maxFiles: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
});
export type InputStagingLimits = z.infer<typeof InputStagingLimitsSchema>;

export const CreateInputStagingResponseSchema = z.object({
  stagingId: InputStagingIdSchema,
  limits: InputStagingLimitsSchema,
});
export type CreateInputStagingResponse = z.infer<typeof CreateInputStagingResponseSchema>;

export const InputStagingFileResponseSchema = z.object({
  /** False when the server skipped the file (junk, not accepted); never an error. */
  stored: z.boolean(),
  path: z.string(),
  reason: TaskInputSkipReasonSchema.optional(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});
export type InputStagingFileResponse = z.infer<typeof InputStagingFileResponseSchema>;
