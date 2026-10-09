import { z } from 'zod';
import { FOLDER_KINDS } from '../folder-kind.js';
import type {
  CloudProvider,
  ForbiddenReason,
  InferMatchedBy,
  WellKnownKind,
} from '../project-inference/types.js';
import { ProjectDetailSchema } from './project.js';

/**
 * Wire shapes for `POST /api/projects/infer-for-path` and
 * `GET /api/projects/well-known-folders`. The enums mirror the TypeScript
 * unions in `project-inference/types.ts`; `satisfies` keeps them honest.
 */

export const InferProjectKindSchema = z.enum(['document', 'folder']);
export type InferProjectKind = z.infer<typeof InferProjectKindSchema>;

export const InferProjectMatchedBySchema = z.enum([
  'existing',
  'well-known',
  'climb',
  'parent',
  'default',
] as const satisfies readonly InferMatchedBy[]);

export const WellKnownFolderKindSchema = z.enum([
  'documents',
  'pictures',
  'desktop',
  'downloads',
  'music',
  'videos',
  'cloud',
] as const satisfies readonly WellKnownKind[]);

export const CloudProviderSchema = z.enum([
  'onedrive',
  'icloud',
  'dropbox',
  'gdrive',
  'box',
  'nextcloud',
  'other',
] as const satisfies readonly CloudProvider[]);

export const ForbiddenRootReasonSchema = z.enum([
  'filesystem-root',
  'network-root',
  'mount-root',
  'user-home',
  'home-container',
  'gezel-home',
  'temp-dir',
  'system-dir',
  'per-user-app-data',
  'hidden-home-dir',
  'cloud-root-parent',
] as const satisfies readonly ForbiddenReason[]);

export const InferProjectForPathRequestSchema = z.object({
  /**
   * Absolute path of the document (or folder, for `kind: 'folder'`). Omit
   * for an unsaved document: the answer is then the Default project.
   */
  path: z.string().min(1).max(4096).optional(),
  kind: InferProjectKindSchema.default('document'),
  /** Mode for a newly created project. Defaults to `solo`, like other folder projects. */
  mode: z.enum(['crew', 'solo']).optional(),
  /** Which client is asking (`office`, `libreoffice`, `vscode`, `first-run`…). Stamped on created projects. */
  source: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  /** `false` previews the answer without creating a project. Default `true`. */
  create: z.boolean().optional(),
  /**
   * Recruit the folder's crew (see `CreateProjectRequest.recruitCrew`), on a
   * project this creates or one that already owns the folder. Honored only
   * from the app's own credential.
   */
  recruitCrew: z.boolean().optional(),
  /** With `recruitCrew`: whether the folder's night work starts on (default) or off. */
  nightWork: z.boolean().optional(),
  /** Used only when a project is created. */
  description: z.string().max(2000).optional(),
  about: z.string().max(20_000).optional(),
  missionObjectives: z.string().max(20_000).optional(),
});
export type InferProjectForPathRequest = z.input<typeof InferProjectForPathRequestSchema>;

/** What a folder holds, counted without reading any file (see the service's `censusFolder`). */
export const FolderCensusSchema = z.object({
  files: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
  videos: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  /** Files whose bytes are only in the cloud (iCloud, OneDrive, …). */
  cloudOnly: z.number().int().nonnegative(),
  newestMtime: z.string().optional(),
  /** False when the count stopped at its file or time budget: "12,000+". */
  complete: z.boolean(),
});
export type FolderCensus = z.infer<typeof FolderCensusSchema>;

export const InferProjectForPathResponseSchema = z.object({
  /** `null` only for a preview (`create: false`) whose answer is a new folder. */
  project: ProjectDetailSchema.nullable(),
  created: z.boolean(),
  matchedBy: InferProjectMatchedBySchema,
  /** The folder that is (or would be) the project's workingDir. Absent for the Default project. */
  root: z.string().optional(),
  /** Display name of the folder that was chosen. */
  name: z.string().optional(),
  /** Whether gezels may write to the project's workspace (same resolver as the UI). */
  readOnly: z.boolean(),
  sharedLibrary: z.boolean().optional(),
  wellKnown: z
    .object({
      kind: WellKnownFolderKindSchema,
      label: z.string(),
      cloud: CloudProviderSchema.optional(),
    })
    .optional(),
  /** Why the Default project was used. */
  reason: z.union([ForbiddenRootReasonSchema, z.enum(['no-candidate', 'no-path'])]).optional(),
  warnings: z.array(z.string()),
  /**
   * For a folder preview (`kind: 'folder'`, `create: false`): what kind of
   * folder it is and what it holds, for the add-folder sheet.
   */
  folder: z
    .object({
      kind: z.enum(FOLDER_KINDS),
      census: FolderCensusSchema,
    })
    .optional(),
});
export type InferProjectForPathResponse = z.infer<typeof InferProjectForPathResponseSchema>;

export const WellKnownFolderInfoSchema = z.object({
  kind: WellKnownFolderKindSchema,
  label: z.string(),
  path: z.string(),
  cloud: CloudProviderSchema.optional(),
  exists: z.boolean(),
  /** Top-level entries, capped; see `truncated`. */
  itemCount: z.number().int().nonnegative().optional(),
  /** Top-level documents (office, pdf, text…). */
  documentCount: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  /** An existing project whose workingDir is exactly this folder. */
  projectId: z.string().optional(),
  sharedLibrary: z.boolean().optional(),
  forbidden: ForbiddenRootReasonSchema.optional(),
  /** Recursive counts; present when the request asked for a census. */
  census: FolderCensusSchema.optional(),
});
export type WellKnownFolderInfo = z.infer<typeof WellKnownFolderInfoSchema>;

/** A git checkout found under the home folder's usual code roots. */
export const CodeFolderInfoSchema = z.object({
  path: z.string(),
  name: z.string(),
  /** An existing project whose workingDir is exactly this folder. */
  projectId: z.string().optional(),
  census: FolderCensusSchema.optional(),
});
export type CodeFolderInfo = z.infer<typeof CodeFolderInfoSchema>;

export const WellKnownFoldersResponseSchema = z.object({
  folders: z.array(WellKnownFolderInfoSchema),
  /** Present when the request asked for a census. */
  codeFolders: z.array(CodeFolderInfoSchema).optional(),
});
export type WellKnownFoldersResponse = z.infer<typeof WellKnownFoldersResponseSchema>;

/**
 * What an indexed folder holds, for the first-look card: "12,480 photos from
 * 2009 to 2026 · about 3,100 look like duplicates · 840 screenshots".
 */
export const ProjectIndexOverviewSchema = z.object({
  files: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
  /** File counts by modality (`image`, `doc`, `code`, `video`, …). */
  byModality: z.record(z.string(), z.number().int().nonnegative()),
  screenshots: z.number().int().nonnegative(),
  /** Files only in the cloud, indexed by name and date. */
  cloudOnly: z.number().int().nonnegative(),
  /** Photos' capture dates (camera local time, `YYYY-MM-DDTHH:MM:SS`). */
  takenRange: z.object({ from: z.string(), to: z.string() }).optional(),
  modifiedRange: z.object({ from: z.string(), to: z.string() }).optional(),
  /** Byte-identical files: groups, copies beyond the first, and the bytes those take. */
  duplicates: z.object({
    groups: z.number().int().nonnegative(),
    extraCopies: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
  }),
});
export type ProjectIndexOverview = z.infer<typeof ProjectIndexOverviewSchema>;
