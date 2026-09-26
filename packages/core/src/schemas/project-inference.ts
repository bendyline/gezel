import { z } from 'zod';
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
  /** Used only when a project is created. */
  description: z.string().max(2000).optional(),
  about: z.string().max(20_000).optional(),
  missionObjectives: z.string().max(20_000).optional(),
});
export type InferProjectForPathRequest = z.input<typeof InferProjectForPathRequestSchema>;

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
});
export type WellKnownFolderInfo = z.infer<typeof WellKnownFolderInfoSchema>;

export const WellKnownFoldersResponseSchema = z.object({
  folders: z.array(WellKnownFolderInfoSchema),
});
export type WellKnownFoldersResponse = z.infer<typeof WellKnownFoldersResponseSchema>;
