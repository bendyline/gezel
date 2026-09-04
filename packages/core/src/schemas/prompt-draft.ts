import { z } from 'zod';

/**
 * Chat prompt drafts — a message the user is still writing, stored on disk as
 * an ordinary document folder under the project's artifacts drawer:
 *
 *   artifacts/prompts/<draftId>/
 *     message.md        the prompt markdown, refs are `message_files/<name>`
 *     message_files/    its uploads
 *     draft.json        the metadata below
 *
 * The composer used to hold drafts in memory only, which made "I'll finish
 * this tomorrow" a lie. A draft is now a document with the same lifetime as
 * anything else the user writes.
 */

/**
 * `YYYY-MM-DD-NNNN`. The date is decoration — it makes a folder listing
 * readable — while the zero-padded, project-wide sequence is the identity.
 * Sorting and allocation both use the sequence, so a clock that moves
 * backwards can never collide with an existing draft.
 */
export const PromptDraftIdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}-\d{4,}$/);
export type PromptDraftId = z.infer<typeof PromptDraftIdSchema>;

/**
 * `draft` is open and editable; `sent` was delivered to a thread and is kept
 * for replay until the retention sweep removes it.
 */
export const PromptDraftStatusSchema = z.enum(['draft', 'sent']);
export type PromptDraftStatus = z.infer<typeof PromptDraftStatusSchema>;

export const PromptDraftMetaSchema = z.object({
  id: PromptDraftIdSchema,
  projectId: z.string(),
  gezelId: z.string(),
  /**
   * The thread this draft is addressed to, or `null` for a draft that will
   * start a new one. Null is a first-class state, not "unset": a person can
   * keep several unsent thread-starters going at once.
   */
  sessionId: z.string().nullable(),
  taskRef: z.string().optional(),
  craftbookRef: z.string().optional(),
  /** The composer surface (`meester`, `gezel`, `project`, …) that owns it. */
  scope: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: PromptDraftStatusSchema,
  sentAt: z.string().optional(),
  sentSessionId: z.string().optional(),
  /**
   * The `at` stamp of the persisted user message this draft became. Lands a
   * beat after `sentAt` — the send route accepts before the turn's message is
   * written — so nothing should gate on its presence.
   */
  sentMessageAt: z.string().optional(),
});
export type PromptDraftMeta = z.infer<typeof PromptDraftMetaSchema>;

/** Meta plus the fields derived at read time. `title` is never stored. */
export const PromptDraftSummarySchema = PromptDraftMetaSchema.extend({
  title: z.string(),
  hasFiles: z.boolean(),
  fileCount: z.number().int().nonnegative(),
});
export type PromptDraftSummary = z.infer<typeof PromptDraftSummarySchema>;

export const PromptDraftSchema = PromptDraftSummarySchema.extend({
  content: z.string(),
});
export type PromptDraft = z.infer<typeof PromptDraftSchema>;

export const CreatePromptDraftRequestSchema = z.object({
  gezelId: z.string().min(1),
  sessionId: z.string().nullable().optional(),
  content: z.string().optional(),
  taskRef: z.string().optional(),
  craftbookRef: z.string().optional(),
  scope: z.string().optional(),
});
export type CreatePromptDraftRequest = z.infer<typeof CreatePromptDraftRequestSchema>;

export const WritePromptDraftContentRequestSchema = z.object({
  content: z.string(),
});
export type WritePromptDraftContentRequest = z.infer<typeof WritePromptDraftContentRequestSchema>;

/**
 * `draft: null` with `deleted: true` when the save emptied it — a draft with
 * no text and no files is not a draft, and leaving the husk behind would fill
 * the picker with blank rows.
 */
export const WritePromptDraftContentResponseSchema = z.object({
  draft: PromptDraftSummarySchema.nullable(),
  deleted: z.boolean(),
});
export type WritePromptDraftContentResponse = z.infer<typeof WritePromptDraftContentResponseSchema>;

/** Re-file a draft. An explicit `null` clears the optional refs. */
export const PatchPromptDraftRequestSchema = z.object({
  gezelId: z.string().min(1).optional(),
  sessionId: z.string().nullable().optional(),
  taskRef: z.string().nullable().optional(),
  craftbookRef: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
});
export type PatchPromptDraftRequest = z.infer<typeof PatchPromptDraftRequestSchema>;

/** Body for "Use again": copy a draft (text + files) into a fresh one. */
export const DuplicatePromptDraftRequestSchema = z.object({
  sessionId: z.string().nullable().optional(),
});
export type DuplicatePromptDraftRequest = z.infer<typeof DuplicatePromptDraftRequestSchema>;

export const ListPromptDraftsResponseSchema = z.object({
  drafts: z.array(PromptDraftSummarySchema),
});
export type ListPromptDraftsResponse = z.infer<typeof ListPromptDraftsResponseSchema>;

export const DeletePromptDraftResponseSchema = z.object({
  ok: z.literal(true),
  deleted: z.boolean(),
});
export type DeletePromptDraftResponse = z.infer<typeof DeletePromptDraftResponseSchema>;

/**
 * Retention policy for sent drafts. Unsent drafts are never swept; `0` keeps
 * sent drafts forever.
 */
export const PromptDraftConfigSchema = z.object({
  keepSentDays: z.number().int().min(0).optional(),
});
export type PromptDraftConfig = z.infer<typeof PromptDraftConfigSchema>;

/**
 * How long a sent draft (and its `message_files/`) is kept. The sweep removes
 * bytes a transcript may still display, which is why the default is generous
 * and `0` means "never sweep".
 */
export const DEFAULT_PROMPT_DRAFT_KEEP_SENT_DAYS = 90;
