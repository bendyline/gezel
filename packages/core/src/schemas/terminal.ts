import { z } from 'zod';

/**
 * One row in a terminal thread — either the user's typed command or the
 * captured output of the run. Threads append both: a `command` row first,
 * then an `output` row when the run completes.
 *
 * `kind` is the discriminator (intentionally NOT `role`, to keep this
 * type lane-separate from `ChatMessage.role: 'user' | 'assistant'` — the
 * project timeline returns a discriminated union of chat + terminal
 * entries, and a string-typed `role` collision would propagate to every
 * consumer).
 */
export const TerminalMessageSchema = z.object({
  id: z.string(),
  kind: z.enum(['command', 'output']),
  /**
   * For `command`: the resolved shell-paste form actually executed.
   * For `output`: combined stdout+stderr text the UI renders. `stdout`
   * and `stderr` are persisted separately on the same row so v2 can
   * split the visual rendering without a schema migration.
   */
  content: z.string(),
  at: z.string(),
  /**
   * `command` rows only — the original user input when the resolver
   * mapped it through the workspace command index (e.g. typed `build`
   * resolved to `pnpm run build`). Absent for raw shell pass-through.
   */
  resolvedFrom: z.string().optional(),
  /** `output` rows only. */
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Set when the 200KB ring-buffer in `runWorkspaceCommand` clipped output. */
  truncated: z.boolean().optional(),
  /** Set when execution failed before producing exitCode (timeout, spawn error, etc.). */
  errorMessage: z.string().optional(),
  /**
   * Display path for the folder pill on this row. Set per-message so
   * the bubble shows the cwd the command actually ran from, not the
   * thread's anchor `workingDir`. After `cd foo`, the next command
   * bubble's `cwd` is `'foo'` (or whatever) and the pill reflects
   * that instead of the original picker selection. Optional for
   * back-compat: messages written before the persistent-shell
   * cwd-tracking landed don't have this field.
   *
   * Format mirrors the workingDirChanged event: project-relative
   * (`''` = root, `'packages/ui'` = subdir) when the shell is
   * inside the workspace, absolute (`'/tmp'`) when it cd'd outside.
   */
  cwd: z.string().optional(),
});
export type TerminalMessage = z.infer<typeof TerminalMessageSchema>;

/**
 * A terminal thread — one persistent stream of commands + outputs scoped
 * to a `(projectId, workingDir)` pair. `workingDir` is stored relative
 * to the project root (`''` = root, `'packages/ui'` = subdir). `id` is
 * a slug of `workingDir`; the raw `workingDir` is also persisted so
 * non-ASCII paths can be reconstructed without relying on slug
 * reversibility.
 *
 * Threads are append-only: opening the same folder later picks up the
 * same thread and appends to `messages[]`.
 */
export const TerminalThreadSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  projectId: z.string(),
  workingDir: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archived: z.boolean().optional(),
  messages: z.array(TerminalMessageSchema),
});
export type TerminalThread = z.infer<typeof TerminalThreadSchema>;

export const TerminalThreadSummarySchema = TerminalThreadSchema.pick({
  id: true,
  projectId: true,
  workingDir: true,
  createdAt: true,
  lastActivityAt: true,
  archived: true,
});
export type TerminalThreadSummary = z.infer<typeof TerminalThreadSummarySchema>;

export const ListTerminalThreadsResponseSchema = z.object({
  threads: z.array(TerminalThreadSummarySchema),
});
export type ListTerminalThreadsResponse = z.infer<typeof ListTerminalThreadsResponseSchema>;

export const RunTerminalCommandRequestSchema = z.object({
  /** Relative to the project root. Empty string targets the root itself. */
  workingDir: z.string(),
  /** Raw user input. The resolver decides whether to map through the index. */
  input: z.string().min(1),
});
export type RunTerminalCommandRequest = z.infer<typeof RunTerminalCommandRequestSchema>;

export const RunTerminalCommandResponseSchema = z.object({
  threadId: z.string(),
  runId: z.string(),
});
export type RunTerminalCommandResponse = z.infer<typeof RunTerminalCommandResponseSchema>;

/**
 * Terminal-entry shape returned in the merged project timeline. Mirrors
 * `TerminalMessage` plus its parent thread identity, so the UI can group
 * consecutive entries by `threadId` and draw the folder pill once per
 * group rather than once per row.
 */
/**
 * SSE envelope shape emitted on the per-project terminal events
 * channel. Discriminated by `kind`:
 *
 *   - `message` — a `command` or `output` row was appended to a
 *     thread. The UI splices it into the matching thread's
 *     timeline rows. This is what every event looked like before
 *     persistent shells; the `kind` field was added when the
 *     second variant (`workingDirChanged`) landed.
 *   - `workingDirChanged` — the shell behind the thread changed
 *     its cwd (typically via the user typing `cd …`). The UI
 *     updates the folder-picker DISPLAY to `newWorkingDir`
 *     without rerouting subsequent commands to a different
 *     thread (the picker becomes a view onto the live shell's
 *     cwd, while the underlying threadId stays stable).
 */
export const TerminalMessageEventSchema = z.object({
  kind: z.literal('message'),
  projectId: z.string(),
  threadId: z.string(),
  workingDir: z.string(),
  message: z.lazy(() => TerminalMessageSchema),
  /**
   * Set when this message terminates an in-flight streaming run —
   * matches the `runId` on `runStarted` / `outputChunk` events.
   * Absent for messages emitted outside a run (intercept outputs,
   * the command bubble itself, etc.). The client uses it to
   * release the matching `TerminalLiveSlot` when the final output
   * arrives.
   */
  runId: z.string().optional(),
});
export type TerminalMessageEvent = z.infer<typeof TerminalMessageEventSchema>;

export const TerminalWorkingDirChangedEventSchema = z.object({
  kind: z.literal('workingDirChanged'),
  projectId: z.string(),
  threadId: z.string(),
  /**
   * Display value for the folder picker. Project-relative when the
   * shell's cwd is inside the project workspace (`''` = project
   * root, `'packages/ui'` = subdir); absolute path when the user
   * cd'd outside the workspace (e.g. `cd /tmp`).
   */
  newWorkingDir: z.string(),
});
export type TerminalWorkingDirChangedEvent = z.infer<typeof TerminalWorkingDirChangedEventSchema>;

/**
 * Fired when the manager starts executing a command (right before
 * `shellPool.run`). The UI uses it to mount a live "growing"
 * bubble keyed by `runId`. The matching `runId` shows up on every
 * subsequent `outputChunk` event and on the final `message`
 * event's `runId` field, so the client can route chunks to the
 * right slot and delete the slot when the persistent output
 * bubble arrives.
 */
export const TerminalRunStartedEventSchema = z.object({
  kind: z.literal('runStarted'),
  projectId: z.string(),
  threadId: z.string(),
  runId: z.string(),
  /** Id of the already-emitted command bubble this run pairs with. */
  commandMessageId: z.string(),
  /** ISO timestamp when the run started. */
  at: z.string(),
  /** Per-row folder pill — same `cwd` value as the paired command bubble. */
  cwd: z.string(),
});
export type TerminalRunStartedEvent = z.infer<typeof TerminalRunStartedEventSchema>;

/**
 * Mid-flight output chunk. NEVER persisted to disk; the final
 * `message` event for the run carries the canonical (capped at
 * 200KB) output and is what gets stored / re-loaded. Chunks are
 * raw UTF-8 with ANSI escapes intact — the client's stateful
 * `AnsiOutput` renderer buffers partial sequences across chunks.
 */
export const TerminalOutputChunkEventSchema = z.object({
  kind: z.literal('outputChunk'),
  projectId: z.string(),
  threadId: z.string(),
  runId: z.string(),
  chunk: z.string(),
});
export type TerminalOutputChunkEvent = z.infer<typeof TerminalOutputChunkEventSchema>;

/**
 * Fired when the shell behind a run goes quiet AND the last
 * output line matches a prompt-shape pattern — strong heuristic
 * for "the command is waiting on stdin." The UI surfaces an
 * inline reply input on the streaming bubble; the matching
 * `inputResolved` event (no schema entry — just a chunk landing
 * with new bytes for the same runId) implicitly dismisses it.
 *
 *   - `text`     → plain text response (generic prompt)
 *   - `password` → masked input; the user's typed value won't be
 *                  echoed by the underlying program (sudo turns
 *                  tty echo off) so the timeline doesn't leak it
 *   - `yes-no`   → Y/N pair plus a free-text fallback
 */
export const TerminalInputRequestedEventSchema = z.object({
  kind: z.literal('inputRequested'),
  projectId: z.string(),
  threadId: z.string(),
  runId: z.string(),
  /** The last (un-newline-terminated) line of output that
   *  triggered the detection; shown to the user as context. */
  promptLine: z.string(),
  mode: z.enum(['text', 'password', 'yes-no']),
});
export type TerminalInputRequestedEvent = z.infer<typeof TerminalInputRequestedEventSchema>;

export const TerminalEventEnvelopeSchema = z.discriminatedUnion('kind', [
  TerminalMessageEventSchema,
  TerminalWorkingDirChangedEventSchema,
  TerminalRunStartedEventSchema,
  TerminalOutputChunkEventSchema,
  TerminalInputRequestedEventSchema,
]);
export type TerminalEventEnvelope = z.infer<typeof TerminalEventEnvelopeSchema>;

export const TerminalTimelineEntrySchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  workingDir: z.string(),
  threadCreatedAt: z.string(),
  threadLastActivityAt: z.string(),
  threadArchived: z.boolean().optional(),
  messageId: z.string(),
  msgKind: z.enum(['command', 'output']),
  content: z.string(),
  at: z.string(),
  resolvedFrom: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  errorMessage: z.string().optional(),
  /** See `TerminalMessage.cwd` — per-row folder-pill display path. */
  cwd: z.string().optional(),
});
export type TerminalTimelineEntry = z.infer<typeof TerminalTimelineEntrySchema>;
