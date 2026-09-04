import { z } from 'zod';
import { NpmPackageNameSchema, NpmRegistryVersionSchema } from './npm-package.js';

/**
 * Structured Q&A between gezels and the user.
 *
 * A `Question` is created when a gezel calls the `ask_user_question` MCP
 * tool. It's pinned to a specific (project, gezel, session) so the answer
 * can be routed back into the conversation that asked. The user picks
 * from `choices` and/or types a `writeIn`; a separate `declined` flag
 * lets them dismiss without answering.
 *
 * Approval flows ride on the optional `taskRef` / `documentPath` fields:
 * the asking gezel attaches the artifact under review and the UI surfaces
 * it inline so the user has full context without leaving the answer
 * surface.
 */

/**
 * Per-package decision for an `npm-install-approval` question.
 * Matches the three buttons the single-package UI used to offer:
 *   - `install` → project-scoped one-off approval
 *   - `always`  → project-scoped always-allow
 *   - `decline` → project-scoped decline
 */
export const NpmInstallApprovalDecisionSchema = z.object({
  package: NpmPackageNameSchema,
  version: NpmRegistryVersionSchema,
  decision: z.enum(['install', 'always', 'decline']),
});
export type NpmInstallApprovalDecision = z.infer<typeof NpmInstallApprovalDecisionSchema>;

export const QuestionAnswerSchema = z.object({
  /** Indices into `choices` the user picked. Empty when only write-in. */
  selectedChoices: z.array(z.number().int().min(0)).optional(),
  /** Free-text the user typed. Empty when they only clicked choices. */
  writeIn: z.string().optional(),
  /**
   * Set when the user explicitly dismissed BUT wants the gezel to
   * proceed anyway with sensible defaults. Triggers a synthetic
   * follow-up turn with a `[The user wants you to proceed…]` seed
   * so the gezel knows to make decisions on the user's behalf.
   *
   * The plain question card no longer offers this — a "decide for me"
   * button next to a question the gezel is blocked on invited the one
   * answer that teaches it nothing. It stays on the approval cards that
   * mean it literally (declining an image generation, an npm install,
   * a schedule) and on the permission broker's dismissal path.
   */
  declined: z.boolean().optional(),
  /**
   * Set when the user just wants the question to go away — no
   * follow-up turn, no work done, nothing for the gezel to act on.
   * The card collapses and the gezel's session is left as-is (its
   * turn already ended when it called `ask_user_question`). Distinct
   * from `declined` so the model never sees a "user wants defaults"
   * signal that the user didn't intend. UI label: "Skip".
   */
  silentSkip: z.boolean().optional(),
  /**
   * Per-package decisions for `npm-install-approval` questions. When
   * set, the answer handler installs / always-allows / declines each
   * package and emits a single follow-up summary into the session.
   */
  npmInstallDecisions: z.array(NpmInstallApprovalDecisionSchema).optional(),
  at: z.string(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

/**
 * Structured intent for special-purpose questions that the service
 * creates internally (not via the `ask_user_question` MCP tool).
 *
 * Examples include npm package approvals, runtime tool permissions, and
 * craftbook MCP-toolset install requests. Each service-owned intent gets
 * a specialized card and answer behavior; plain questions remain generic.
 *
 * Plain questions asked via `ask_user_question` leave `intent`
 * unset — existing rendering path is unchanged.
 */
export const NpmInstallApprovalPackageSchema = z.object({
  package: NpmPackageNameSchema,
  version: NpmRegistryVersionSchema,
});
export type NpmInstallApprovalPackage = z.infer<typeof NpmInstallApprovalPackageSchema>;

/**
 * First-use approval for `run_package_script` / `run_npx`. The gezel
 * calling one of those MCP tools against an unapproved entry creates
 * this intent; the answer handler (questions route) flips the entry in
 * the project's `command-approvals.json` and emits a follow-up seed.
 *
 *   - `scope: 'script'` — a `package.json` script key.
 *   - `scope: 'npx'`    — a binary in the workspace's `node_modules/.bin`.
 *
 * `body` carries the script body (or resolved bin path) verbatim so the
 * approval UI can show the user what they're consenting to. `args` are
 * the extra args the gezel wanted to pass on this specific run. The
 * service hashes the ordered argument vector together with `body` and the
 * `inputFiles` content snapshot, so a persisted approval cannot be replayed
 * with different arguments or modified identifiable input files.
 */
export const CommandApprovalScopeSchema = z.enum(['script', 'npx']);
export type CommandApprovalScope = z.infer<typeof CommandApprovalScopeSchema>;

export const CommandApprovalInputFileSchema = z.object({
  /** Workspace-relative, slash-normalized path shown in the approval prompt. */
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CommandApprovalInputFile = z.infer<typeof CommandApprovalInputFileSchema>;

export const CommandApprovalIntentSchema = z.object({
  kind: z.literal('command-approval'),
  scope: CommandApprovalScopeSchema,
  name: z.string().min(1),
  body: z.string().optional(),
  args: z.array(z.string()).optional(),
  inputFiles: z.array(CommandApprovalInputFileSchema).max(128).optional(),
});
export type CommandApprovalIntent = z.infer<typeof CommandApprovalIntentSchema>;

/**
 * Approval question created by the Claude CLI provider via the CLI's
 * `--permission-prompt-tool` hook. Whenever the model requests an MCP
 * tool that requires permission (browser navigation, write-to-disk
 * outside `acceptEdits`, etc.), the CLI invokes our gezel-mcp
 * `request_tool_permission` tool, which posts a question with this
 * intent and blocks until the user answers Allow / Deny.
 *
 * `toolName` is the MCP tool reference Claude is requesting, in the
 * format the CLI uses (`mcp__<server>__<tool>` for MCP, or a bare name
 * for Claude built-ins). `toolInput` is the parsed args the model
 * wants to call it with — surfaced to the user verbatim so they can
 * see exactly what's about to run.
 *
 * Unlike `npm-install-approval` and `command-approval`, the answer
 * does NOT seed a follow-up turn: the gezel's session is alive and
 * mid-turn, with the `claude` subprocess synchronously awaiting the
 * permission verdict via the long-polling endpoint
 * `POST /api/permissions/request-and-wait`. Once the user answers,
 * that endpoint returns the verdict to gezel-mcp, gezel-mcp returns
 * it to Claude CLI, and the CLI either runs the tool or feeds the
 * deny message back to the model.
 */
export const ToolPermissionIntentSchema = z.object({
  kind: z.literal('tool-permission'),
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
});
export type ToolPermissionIntent = z.infer<typeof ToolPermissionIntentSchema>;

/**
 * A clarifying question asked by Claude CLI's built-in `AskUserQuestion`
 * tool, intercepted by the tool-permission broker
 * (`POST /api/permissions/request-and-wait`) and re-shaped into a real
 * question card instead of a generic Allow/Deny permission blob. The
 * broker answers the CLI through the permission contract: the user's
 * selection is folded into `updatedInput.answers` on allow, so the tool
 * call itself succeeds with the answer — there is no "allow" to grant.
 *
 * The gezel `Question`'s own `prompt` / `choices` / `multiSelect` carry
 * the render-ready shape; this intent adds what those can't hold — the
 * per-option descriptions, the CLI's short `header` chip, and the
 * position within a multi-question call — and marks the answer route to
 * skip follow-up-turn seeding (the `claude` subprocess is mid-turn,
 * synchronously awaiting the verdict, exactly like `tool-permission`).
 */
export const ClaudeUserQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});
export type ClaudeUserQuestionOption = z.infer<typeof ClaudeUserQuestionOptionSchema>;

export const ClaudeUserQuestionIntentSchema = z.object({
  kind: z.literal('claude-user-question'),
  /** The CLI's short topic chip for the question (e.g. "Gate block"). */
  header: z.string().optional(),
  /** Options with descriptions; labels mirror the Question's `choices`. */
  options: z.array(ClaudeUserQuestionOptionSchema),
  /** 0-based position within the originating multi-question call. */
  questionIndex: z.number().int().min(0),
  /** Total questions in the originating call (cards appear sequentially). */
  questionCount: z.number().int().min(1),
});
export type ClaudeUserQuestionIntent = z.infer<typeof ClaudeUserQuestionIntentSchema>;

/**
 * Approval for a craftbook's missing zero-configuration MCP toolset.
 *
 * Trusted, pinned first-party dependencies (currently DocBlocks) install
 * without interrupting the user. Other code-bearing or remote MCPs pause
 * the live craftbook invocation here before anything is downloaded or
 * registered. The catalog request route long-polls this question, installs
 * after an explicit Allow, then lets the original invocation continue.
 * Toolsets with required configuration do not use this intent because an
 * approval click cannot supply credentials or settings.
 */
export const ToolsetInstallApprovalIntentSchema = z.object({
  kind: z.literal('toolset-install-approval'),
  toolsetId: z.string(),
  sourceId: z.string(),
  version: z.string(),
  targetProjectId: z.string(),
  craftbookId: z.string(),
});
export type ToolsetInstallApprovalIntent = z.infer<typeof ToolsetInstallApprovalIntentSchema>;

/**
 * Cost-confirmation question created by the service before invoking a
 * cloud image-generation API. The `POST /api/image-gen/generate` route
 * synthesizes this intent when `config.imageGenerationConfirmation` is
 * `'ask'` (or undefined) AND the active image provider is cloud, then
 * blocks the response via the long-poll pattern (mirror of
 * `tool-permission`) until the user picks `Allow once` / `Always allow`
 * / `Decline`.
 *
 *   - `Allow once`     → selectedChoices: [0] — proceed with this call
 *   - `Always allow`   → selectedChoices: [1] — flip
 *                          `imageGenerationConfirmation` to
 *                          `'always-allow'` and proceed
 *   - `Decline` / dismiss → selectedChoices: [2] / declined: true —
 *                          generation cancelled, MCP tool surfaces a
 *                          clear "user declined" error to the model
 */
export const ImageGenerationApprovalIntentSchema = z.object({
  kind: z.literal('image-generation-approval'),
  provider: z.string(),
  model: z.string(),
  /** Truncated prompt the model is about to send. Surfaced verbatim. */
  promptPreview: z.string(),
  /** Resolved generation size, e.g. '2K 16:9' or '1024x1024'. Optional. */
  estimatedSize: z.string().optional(),
});
export type ImageGenerationApprovalIntent = z.infer<typeof ImageGenerationApprovalIntentSchema>;

/**
 * Cost/duration confirmation for video generation. Parallels
 * {@link ImageGenerationApprovalIntentSchema}, but local video gen also
 * consults it (not just cloud) — a multi-minute, GPU-monopolizing job
 * that evicts the chat model is a surprise worth gating even on-device.
 */
export const VideoGenerationApprovalIntentSchema = z.object({
  kind: z.literal('video-generation-approval'),
  provider: z.string(),
  model: z.string(),
  promptPreview: z.string(),
  /** Resolved clip shape, e.g. '704×480 · 97f · 24fps'. Optional. */
  estimatedSize: z.string().optional(),
});
export type VideoGenerationApprovalIntent = z.infer<typeof VideoGenerationApprovalIntentSchema>;

/**
 * Consent question created at project-type adoption for a declared
 * schedule with `consent: 'ask'`. The schedule host task is created
 * PAUSED (never silently armed — docs/project-types.md); the answer
 * route arms it:
 *
 *   - `Enable schedule` → selectedChoices: [0] — re-derive `nextTickAt`
 *       from now (via a cron update) and set the host active
 *   - `Keep paused` / dismiss → host stays paused; the user can enable
 *       it any time from the Tasks view
 *
 * The host task rides the standard `taskRef` attachment.
 */
export const ScheduleApprovalIntentSchema = z.object({
  kind: z.literal('schedule-approval'),
  typeId: z.string(),
  craftbookId: z.string(),
  /**
   * Recurrence flavor. Absent → 'scheduled' (every question written
   * before this field existed is a cron schedule). 'night-shift' hosts
   * run inside the Night Shift window instead of on a user-visible cron;
   * the card copy switches accordingly.
   */
  runMode: z.enum(['scheduled', 'night-shift']).optional(),
  /**
   * 5-field cron expression (UTC). Surfaced verbatim on the card for
   * 'scheduled' hosts; for 'night-shift' hosts it is the internal
   * heartbeat and the card shows the window instead.
   */
  cron: z.string(),
  overlap: z.enum(['skip', 'queue', 'concurrent']).optional(),
});
export type ScheduleApprovalIntent = z.infer<typeof ScheduleApprovalIntentSchema>;

/**
 * The morning-review question, synthesized once per completed night
 * window (deduped on `windowKey` — the question store IS the "already
 * asked for window K" state). Created by the NightShiftManager's
 * window-settled callback with `sessionId: ''`; the answer route
 * early-returns (nothing to seed — the card is a summary with report
 * links, and Dismiss just collapses it).
 */
export const NightShiftReviewIntentSchema = z.object({
  kind: z.literal('night-shift-review'),
  /** The window's day key (see `nightShiftWindowKey`). */
  windowKey: z.string(),
  tasksCompleted: z.number(),
  reports: z.array(
    z.object({
      projectId: z.string(),
      path: z.string(),
      title: z.string().optional(),
      actionCount: z.number(),
    }),
  ),
});
export type NightShiftReviewIntent = z.infer<typeof NightShiftReviewIntentSchema>;

/**
 * Why a task paused for help. `gate_unsatisfiable` and
 * `gate_infrastructure` and `step_exit_infrastructure` pause without
 * consuming a deliverable attempt (policy / runtime problems, not failed
 * work); the others are spent budgets. Mirrors `TaskNeedsHelpReason` in the
 * service task manager.
 */
export const TaskPausedReasonSchema = z.enum([
  'gate_exhausted',
  'gate_plateau',
  'gate_unsatisfiable',
  'gate_infrastructure',
  'step_exit_infrastructure',
  'step_stalled',
  'budget_exhausted',
]);
export type TaskPausedReason = z.infer<typeof TaskPausedReasonSchema>;

/**
 * Service-created "task paused for help" card. A background task that
 * pauses (gate budget spent, plateau, unsatisfiable-by-policy gate,
 * stalled assignee) would otherwise go silent — only complete/canceled
 * fire settle notifications, so a night-shift task that hit a wall was
 * discoverable only by opening the Tasks view. Like the night-shift
 * review card there is no live session (`sessionId` is ''); answering
 * just collapses the card, and the attached `taskRef` gives the UI its
 * "Open task" link.
 */
export const TaskPausedIntentSchema = z.object({
  kind: z.literal('task-paused'),
  /** `projectId/num` of the paused task — the dedup key. */
  taskRef: z.string(),
  stepId: z.string().optional(),
  reason: TaskPausedReasonSchema,
});
export type TaskPausedIntent = z.infer<typeof TaskPausedIntentSchema>;

export const QuestionIntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('npm-install-approval'),
    /**
     * Packages that need approval. Always at least one; multiple when
     * the gezel batched an install call (encouraged) or when we merged
     * a later request into the same pending question for dedup.
     */
    packages: z.array(NpmInstallApprovalPackageSchema).min(1),
  }),
  CommandApprovalIntentSchema,
  ToolPermissionIntentSchema,
  ClaudeUserQuestionIntentSchema,
  ToolsetInstallApprovalIntentSchema,
  ImageGenerationApprovalIntentSchema,
  VideoGenerationApprovalIntentSchema,
  ScheduleApprovalIntentSchema,
  NightShiftReviewIntentSchema,
  TaskPausedIntentSchema,
]);
export type QuestionIntent = z.infer<typeof QuestionIntentSchema>;

export const QuestionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  gezelId: z.string(),
  sessionId: z.string(),
  /** Body of the question — supports markdown. */
  prompt: z.string().min(1),
  /** Optional preset choices. Empty / omitted => write-in only. */
  choices: z.array(z.string()).max(20).optional(),
  /** Whether the user can also type a write-in alongside choices. Default true. */
  allowWriteIn: z.boolean().optional(),
  /** Whether multiple choices may be selected. Default false. */
  multiSelect: z.boolean().optional(),
  /**
   * Approval-flow attachment: a task this question is *about*. Stored in
   * `projectId/num` form so existing parsing helpers work. The UI shows
   * the task title + status above the prompt and offers an "Open task"
   * link.
   */
  taskRef: z.string().optional(),
  /**
   * Approval-flow attachment: a document this question is *about*.
   * Project-relative path when `projectId` is set, otherwise into the
   * global `~/.gezel/documents/` library. The UI renders a collapsed
   * preview + "Open document" link.
   */
  documentPath: z.string().optional(),
  /**
   * Service-created specialized-question marker (see `QuestionIntent`
   * for context). Absent for plain user-facing questions asked via
   * the `ask_user_question` MCP tool.
   */
  intent: QuestionIntentSchema.optional(),
  createdAt: z.string(),
  /** Set once the user has answered (or declined). */
  answer: QuestionAnswerSchema.optional(),
});
export type Question = z.infer<typeof QuestionSchema>;
