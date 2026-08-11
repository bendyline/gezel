import { z } from 'zod';
import { ProviderNameSchema } from './gezel.js';

/**
 * The audit log. Explicit events (gezel + project + tool + document) are
 * append-logged as they happen. Session entries are derived at query time
 * from the existing ChatSession records on disk — no duplicate storage.
 */

export const HistoryEventKindSchema = z.enum([
  'gezel.created',
  'gezel.deleted',
  'gezel.renamed',
  'gezel.settings.updated',
  'gezel.about.generated',
  'icon.generated',
  'icon.reverted',
  /** The gezel's poppetje was generated, replaced, or rerolled. */
  'poppetje.generated',
  'poppetje.updated',
  'poppetje.rerolled',
  'project.created',
  'project.deleted',
  'project.updated',
  'project.about.updated',
  'project.mission.updated',
  'project.voorman.changed',
  /**
   * A gezel was added to a project's roster — either explicitly via
   * `add_gezel_to_project` / the HTTP roster endpoint, or implicitly
   * the first time the gezel was set as voorman, started a session
   * scoped to the project, was pinged via `message_gezel`/`ask_gezel`,
   * or was assigned to a task in the project. `details.source` carries
   * which path triggered the join.
   */
  'project.gezel.joined',
  /**
   * A gezel was removed from a project's roster. Manual only —
   * removing via tool/UI doesn't tear down their existing sessions
   * or task assignments, just drops them from the membership list.
   */
  'project.gezel.left',
  /**
   * A suggested-work item (role- or project-type-recommended recurring
   * craftbook) was enabled/disabled via the toggle surface. `details`
   * carries `{ key, craftbookId, runMode, taskRef }`.
   */
  'project.suggested-work.enabled',
  'project.suggested-work.disabled',
  /** A project property changed. `details` carries `{ id, value }` per entry. */
  'project.properties.updated',
  /**
   * A report's embedded action request was fired (task created / edit
   * pack applied) or dismissed by the user. `details` carries
   * `{ reportPath, actionId, kind, state?, taskRef?, targetProjectId? }`.
   */
  'report.action.fired',
  'report.action.dismissed',
  'project.status.changed',
  'project.nudge.sent',
  'project.github.linked',
  'project.github.unlinked',
  'project.github.synced',
  'project.review.requested',
  'project.review.settled',
  'project.connector.bound',
  'project.connector.unbound',
  'project.connector.synced',
  'document.created',
  'document.renamed',
  'document.deleted',
  'workspace.write',
  'workspace.delete',
  'workspace.mkdir',
  'workspace.move',
  'workspace.npm.installed',
  'workspace.npm.declined',
  'workspace.script.run',
  'workspace.script.declined',
  'workspace.npx.run',
  'workspace.npx.declined',
  /**
   * The user typed a command into the in-chat terminal and it ran. Distinct
   * from `workspace.script.run` / `workspace.npx.run`, which fire when a
   * gezel invokes those tools via MCP — `terminal.command.run` always
   * carries `details.source: 'user-terminal'` so the audit log
   * distinguishes "user typed this" from "gezel called this".
   */
  'terminal.command.run',
  'workspace.allow-writes.changed',
  'tool.called',
  /**
   * A project-type page invoked one of its declared `pages.tools` through
   * the first-party page-invoke route. `details` carries `{ tool, script,
   * runId, status }`.
   */
  'page.tool.invoked',
  /**
   * A page-invoked tool's declared reaction summoned a gezel turn.
   * `details` carries `{ tool, gezelId, sessionId, runId }`.
   */
  'page.reaction.sent',
  /**
   * A craftbook PreToolUse / PostToolUse hook returned a decision. The
   * `details` payload carries `{ phase, tool, decision, message?,
   * craftbookId, hookLabel? }`. Always written; the bridge emits one
   * event per hook that fired (so a deny from hook A is auditable
   * even if hook B would have allowed).
   */
  'tool.gated',
  'meester.changed',
  'klerk.changed',
  'boekwachter.changed',
  'keurmeester.changed',
  /**
   * A newer gilde content release was activated by the live-update
   * mechanism (opt-in). `details` carries
   * `{ previousVersion, version, trigger }` — `previousVersion` is the
   * bundled pin when this is the first live activation.
   */
  'gilde.updated',
  /**
   * A third-party app completed a chat turn through the public
   * OpenAI-compatible surface (`/v1/responses`, `/v1/chat/completions`) or the Ollama
   * facade/emulation. `details` carries `{ appId, surface, model,
   * provider, inputTokens?, outputTokens? }` — `appId` is
   * `'unauthenticated'` for the no-auth Ollama emulation listener.
   */
  'v1.chat.completion',
  /**
   * A Keurmeester consult produced a verdict. `details` carries
   * `{ caseId, trigger, failureClass, action, applied, taskRef?, stepId? }`
   * — the full case record (prompt sizes, signals, debug payloads)
   * lives in `~/.gezel/keurmeester/cases/`, keyed by the same caseId.
   */
  'keurmeester.intervention',
  'keurmeester.digest.generated',
  'task.created',
  'task.activated',
  'task.updated',
  'task.status.changed',
  'task.assignee.changed',
  'task.step.added',
  'task.step.activated',
  'task.step.completed',
  // Idle step supervisor: re-poked a silently-stalled assignee, or paused
  // the task after the re-drive budget ran out. See TaskScheduler.sweepStuckSteps.
  'task.step.redriven',
  'task.step.stalled',
  // A step gate evaluated a deliverable — approve or reject. Carries the
  // craftbook join key (details.bookCatalogId) so per-book held/approve
  // rates (never-fires vs always-holds) are aggregable, plus the failing
  // check kinds for calibration. Emitted once per real evaluation; damped
  // byte-identical replays do not emit.
  'task.step.gated',
  // Per-step model routing picked a different model than default
  // resolution would have (capability-floor routing at handoff
  // dispatch). Details carry `{ ref, stepId, gezelId, provider, model,
  // tier, capabilityFloor, reason, defaultModel? }`. Not emitted when
  // the pick equals the default (no override applied).
  'task.step.routed',
  // The single-channel kickoff: a task's entry step was enqueued for
  // handoff dispatch right after create (dispatchEntry flag or the
  // command launcher). Details carry `{ ref, stepId, gezelId }`. This
  // replaced the old separate chat-notify — the kickoff story the
  // `gezel.messaged` event used to tell.
  'task.entry.dispatched',
  // The tier-collapse pass rendered a task's embedded craftbook for a
  // small executor tier at handoff dispatch (D3): steps merged to a
  // ≤3-step linear chain, gates carried verbatim. Details:
  // `{ ref, fromSteps, toSteps, tier }`.
  'task.craftbook.tier-collapsed',
  'task.tick',
  'task.canceled',
  'task.instance.spawned',
  'task.fanout.materialized',
  'tasknote.appended',
  'tasknote.updated',
  'tasknote.deleted',
  'task.about.updated',
  'task.step.updated',
  'task.step.removed',
  'task.craftbook.reordered',
  'task.craftbook.updated',
  'craftbook.created',
  'craftbook.updated',
  'craftbook.deleted',
  'toolset.config.updated',
  'config.credential.updated',
  'config.engagementMode.changed',
  'memory.auto-recalled',
  'memory.auto-summarized',
  'memory.compacted',
  'memory.lessons-updated',
  'project.digest.generated',
  /**
   * The boekwachter review sweep DRAINED for a project — every eligible file
   * is reviewed under the current content/rubrics. Emitted once per content
   * wave (on the pending→0 transition), never per file; details carry
   * `{ files, issues, model }`.
   */
  'project.index.reviewed',
  'meester.status.generated',
  'gezel.level.up',
  'gezel.trait.adopted',
  'gezel.trait.removed',
  'gezel.tuning.adjusted',
  'chat.compacted',
  'gezel.messaged',
  /**
   * The target gezel's turn for a `messageGezel` (or scheduler-driven
   * ambient nudge) completed without throwing — the message reached the
   * target and produced a response. Pair with `gezel.messaged` to
   * audit which Meester pings actually got the voorman talking.
   */
  'gezel.message.delivered',
  /**
   * The target gezel's turn for a `messageGezel` rejected — the queue
   * stayed busy past the retry window, the provider errored, etc. The
   * message was logged via `gezel.messaged` but never produced a turn
   * the user can read.
   */
  'gezel.message.delivery_failed',
  'gezel.reply.dropped',
  'chat.mention.fanout',
  'render.generated',
  'user.question.asked',
  'user.question.answered',
  'debug.bridge.failed',
  'channel.configured',
  'channel.message.sent',
  'channel.message.failed',
  /**
   * Sandbox mode denied a Copilot SDK built-in tool call (bash, web_fetch,
   * file edit, etc.). Recovers the audit trail for tools the Copilot CLI
   * normally runs inside its subprocess and hides from us.
   */
  'copilot.builtin.denied',
  /**
   * A named credential (e.g. `github.token`) was resolved by the
   * CredentialRegistry for a script run or MCP tool invocation. Emit
   * enough detail for "what has this token been used for?" audits —
   * the credential name, the project that requested it, and the
   * triggering script/session. Never the value.
   */
  'credential.used',
  /**
   * An eval trial was kicked off via the in-app Benchmarks panel (or
   * via the /api/eval/run endpoint directly). `details` carries
   * scenarioId, modelId, and optional imageModelId. Always paired with
   * a later `eval.trial.completed` for the same trialId; orphans here
   * indicate the service died mid-trial.
   */
  'eval.trial.started',
  /**
   * An eval trial finished — pass or fail. `details` carries the full
   * `TrialOutcome` (trialId, durationMs, success, failureMode, etc.).
   * Used by the Benchmarks history view + future regression detector.
   */
  'eval.trial.completed',
]);
export type HistoryEventKind = z.infer<typeof HistoryEventKindSchema>;

export const HistoryEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: HistoryEventKindSchema,
  projectId: z.string().optional(),
  gezelId: z.string().optional(),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

export const HistorySessionEntrySchema = z.object({
  entryType: z.literal('session'),
  id: z.string(),
  gezelId: z.string(),
  projectId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  messageCount: z.number(),
  durationMs: z.number(),
  providerName: ProviderNameSchema,
  model: z.string().optional(),
  archived: z.boolean().optional(),
});
export type HistorySessionEntry = z.infer<typeof HistorySessionEntrySchema>;

export const HistoryEventEntrySchema = HistoryEventSchema.extend({
  entryType: z.literal('event'),
});

export const HistoryEntrySchema = z.discriminatedUnion('entryType', [
  HistoryEventEntrySchema,
  HistorySessionEntrySchema,
]);
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const HistoryFilterSchema = z.object({
  projectId: z.string().optional(),
  gezelId: z.string().optional(),
  kinds: z.array(HistoryEventKindSchema).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().optional(),
  limit: z.number().int().positive().optional(),
  include: z.enum(['events', 'entries']).optional(),
});
export type HistoryFilter = z.infer<typeof HistoryFilterSchema>;

export const ListHistoryResponseSchema = z.object({
  entries: z.array(HistoryEntrySchema),
});
export type ListHistoryResponse = z.infer<typeof ListHistoryResponseSchema>;
