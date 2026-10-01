import { z } from 'zod';

/**
 * Which store a referenced file lives in. Documents are deliberately not a
 * third kind: the shared library is a project (ADR 0006), so its files
 * arrive as that project's `workspace`.
 */
export const ReferencedFileKindSchema = z.enum(['artifact', 'workspace']);
export type ReferencedFileKind = z.infer<typeof ReferencedFileKindSchema>;

/**
 * One real file an assistant reply named in its body text. `path` is
 * relative to the store named by `kind` — the project's `artifacts/`
 * drawer or its workspace root — and is always the canonical on-disk
 * spelling, never the model's. Any `:line` / `#Lnn` locator the model
 * wrote is stripped before matching; the inline link keeps it as label
 * text, but nothing downstream resolves a path with one attached.
 */
export const ReferencedFileSchema = z.object({
  kind: ReferencedFileKindSchema,
  path: z.string(),
});
export type ReferencedFile = z.infer<typeof ReferencedFileSchema>;

/**
 * The one file a task hands its owner — the PowerPoint, the report, the
 * page — as opposed to the sources, outlines, and reviews it made on the
 * way. Resolved by the service from the task's craftbook and what its
 * sessions wrote (see `task-deliverable.ts`), and only ever for a file that
 * exists: `bytes` / `modifiedAt` are the stat taken when it was resolved.
 */
export const TaskDeliverableSchema = ReferencedFileSchema.extend({
  bytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().optional(),
});
export type TaskDeliverable = z.infer<typeof TaskDeliverableSchema>;
