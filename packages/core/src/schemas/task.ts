import { z } from 'zod';
import { TaskAssigneeSchema } from './assignee.js';
import {
  AdvanceWhenSchema,
  CraftbookBasedOnSchema,
  CraftbookBranchSchema,
  CraftbookConnectorNeedSchema,
  CraftbookSchema,
  CraftbookScriptsSchema,
  CraftbookSpawnSchema,
  CraftbookStepInputSchema,
  CraftbookStepSchema,
  CraftbookToolsetNeedSchema,
  ModelTierSchema,
  NewCraftbookStepSchema,
  StepGateUnionSchema,
} from './craftbook.js';
import { HookSpecSchema } from './hook.js';
import { ScriptRefListSchema } from './script.js';

// Re-export so existing consumers of `TaskAssignee` from this module keep working.
export { TaskAssigneeSchema };
export type { TaskAssignee } from './assignee.js';

/**
 * Task workflow status. "Active" tasks are what the scheduler ticks.
 * "Draft" tasks (e.g. a plan being authored) exist and are editable but
 * are inert — never ticked, never dispatched, and not counted as pending
 * "active" work — until activated (draft → active via `TaskManager.activate`).
 * The remaining three are terminal-ish and do not get revisit pings.
 */
export const TaskStatusSchema = z.enum(['draft', 'paused', 'active', 'complete', 'canceled']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * When a cron fires while an earlier child instance is still running:
 *   - skip:       don't spawn a new child if a non-terminal one exists
 *   - queue:      always spawn; let the handoff runner throttle
 *   - concurrent: always spawn; no overlap guard
 */
export const TaskCronOverlapSchema = z.enum(['skip', 'queue', 'concurrent']);
export type TaskCronOverlap = z.infer<typeof TaskCronOverlapSchema>;

export const TaskCronSchema = z.object({
  expression: z.string(),
  lastTickAt: z.string().optional(),
  nextTickAt: z.string().optional(),
  overlap: TaskCronOverlapSchema.optional(),
});
export type TaskCron = z.infer<typeof TaskCronSchema>;

/**
 * Optional per-child overrides applied on top of the cloned spawn
 * craftbook. Plain string substitution only — no templating engine.
 */
export const TaskVariationSchema = z.object({
  title: z.string().optional(),
  plan: z.string().optional(),
  description: z.string().optional(),
  context: z.record(z.string(), z.string()).optional(),
});
export type TaskVariation = z.infer<typeof TaskVariationSchema>;

/**
 * Declarative fanout: on create, materialize `count` children from the
 * parent's spawn craftbook. Idempotent via `materializedAt`.
 */
export const TaskFanoutSchema = z.object({
  count: z.number().int().positive(),
  variations: z.array(TaskVariationSchema).optional(),
  materializedAt: z.string().optional(),
});
export type TaskFanout = z.infer<typeof TaskFanoutSchema>;

export const NewTaskFanoutSchema = z.object({
  count: z.number().int().positive(),
  variations: z.array(TaskVariationSchema).optional(),
});
export type NewTaskFanout = z.infer<typeof NewTaskFanoutSchema>;

/**
 * Night-shift deferral. A task with `enabled` only gets its handoffs
 * dispatched/advanced while Night Shift mode is ON (configured nightly
 * window or a manual shift) — see `NightShiftManager`. Interactive and
 * scheduled work always preempts it.
 *
 * `onceADay` adds a run-once-per-night guard that composes with
 * `enabled` (the bundled meester oversight task is `{enabled, onceADay}`
 * with no cron). `lastRunDay` is the 'YYYY-MM-DD' night-window day key
 * of the last run. It is stamped from two disjoint sites that can never
 * collide: workable tasks stamp on step completion (they never spawn),
 * and night-shift spawn hosts stamp at child-spawn time in the scheduler
 * (their placeholder step never completes) — giving hosts "at most one
 * spawn per night window" semantics.
 */
export const TaskNightShiftSchema = z.object({
  enabled: z.boolean(),
  onceADay: z.boolean().optional(),
  lastRunDay: z.string().optional(),
});
export type TaskNightShift = z.infer<typeof TaskNightShiftSchema>;

/* ─── Task-embedded craftbook ─────────────────────────────────────────── */

/**
 * A craftbook step embedded in a task carries per-instance lifecycle
 * fields (`createdAt`, optional `completedAt`) on top of the recipe
 * shape. Edge fields are snapshotted from the source craftbook at
 * task-create time — advancement reads from this snapshot, so editing
 * the source craftbook does NOT affect a running task.
 *
 * `attemptCount` / `lastActivatedAt` track how many times the step has
 * been *activated* (handed off to an assignee). A linear run touches
 * each step once (attemptCount 1); a looping craftbook (e.g. build-loop's
 * `evaluate → build` cycle) re-activates a step on every pass, so the
 * count climbs. This is what lets a voorman see "we've poked the dev
 * step 3 times" and decide to re-poke vs. escalate — and what the eval
 * harness reads to confirm a model actually looped and recovered rather
 * than one-shotting.
 */
export const TaskCraftbookStepSchema = CraftbookStepSchema.extend({
  createdAt: z.string(),
  completedAt: z.string().optional(),
  attemptCount: z.number().int().nonnegative().optional(),
  lastActivatedAt: z.string().optional(),
  /**
   * Completion-gate rejections since this step last activated. Distinct
   * from `attemptCount` (which counts ACTIVATIONS — loop-backs): a
   * rejection holds the step active without re-activating it. Reset by
   * `bumpStepActivation` so a loop-back grants a fresh budget.
   */
  gateAttempts: z.number().int().nonnegative().optional(),
  /**
   * Repeat-reject damper. When the gated deliverable is byte-identical
   * to what the gate last rejected, the runtime returns this cached
   * rejection instead of re-running gate scripts, and the chat nudge
   * dedupes on `messageFingerprint`.
   */
  lastGateReject: z
    .object({
      contentHash: z.string().optional(),
      messageFingerprint: z.string(),
      message: z.string(),
      at: z.string(),
    })
    .optional(),
  /**
   * Anti-stall re-drive bookkeeping for the idle step supervisor
   * (`TaskScheduler.sweepStuckSteps`). `redriveCount` = how many times the
   * supervisor has re-poked THIS active step after it went idle without
   * advancing; `lastRedriveAt` = when it last did (also the cooldown
   * anchor so a re-drive isn't itself read as fresh progress). Distinct
   * from `attemptCount` (activations) and `gateAttempts` (gate
   * rejections), which count model-driven events — these count autonomous
   * re-pokes of a silent assignee. Reset by `bumpStepActivation` so a
   * fresh activation / loop-back grants a fresh re-drive budget.
   */
  redriveCount: z.number().int().nonnegative().optional(),
  lastRedriveAt: z.string().optional(),
  /**
   * Rolling reject trail (capped at 8 entries, oldest dropped). One entry
   * per real completion-gate rejection PLUS one per damped byte-identical
   * resubmit (`frozen: true`). `signatureHash` hashes the failing-check
   * IDENTITY set (GateCheckOutcome labels), not prose or bytes — byte
   * churn with an unmoved failure set IS a plateau; a cleared check
   * changes the signature and resets the ladder.
   *
   * Deliberately NOT stripped by `bumpStepActivation`: `onReject: <self>`
   * loop gates reset `gateAttempts`/`lastGateReject` on every pass, so
   * this trail is the only cross-activation plateau memory. Self-healing
   * — real progress changes the trailing signature.
   */
  gateAttemptHistory: z
    .array(
      z.object({
        at: z.string(),
        attempt: z.number().int().nonnegative(),
        contentHash: z.string().optional(),
        signatureHash: z.string(),
        messageFingerprint: z.string(),
        /** Failing GateCheckOutcome labels (or `script:<name>`). */
        failedChecks: z.array(z.string()).optional(),
        /** True when this entry records a damped byte-identical resubmit. */
        frozen: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type TaskCraftbookStep = z.infer<typeof TaskCraftbookStepSchema>;
export type GateAttemptRecord = NonNullable<TaskCraftbookStep['gateAttemptHistory']>[number];

/**
 * The full embedded craftbook copy on a task. Identical structure to
 * `Craftbook` except that steps carry per-instance lifecycle fields.
 *
 * `triggers`, `hooks`, `toolsets`, and `connectors` are snapshotted from
 * the source craftbook at task-create time so live tasks remain insulated
 * from edits to the catalog template. `toolsets` is needed here so the chat
 * session's auto-allow derivation can read it without re-resolving the
 * catalog book; `connectors` records the corpus the task was launched
 * against.
 */
export const TaskCraftbookSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  basedOn: CraftbookBasedOnSchema.optional(),
  plan: z.string().optional(),
  defaultAssignee: TaskAssigneeSchema.optional(),
  steps: z.array(TaskCraftbookStepSchema).min(1),
  entryStepId: z.string().min(1),
  triggers: z.array(z.string()).optional(),
  hooks: z.array(HookSpecSchema).optional(),
  /** Invocation schema retained with the task snapshot for audit/UI context. */
  paramSchema: z.record(z.string(), z.unknown()).optional(),
  toolsets: z.array(CraftbookToolsetNeedSchema).optional(),
  connectors: z.array(CraftbookConnectorNeedSchema).optional(),
  /**
   * Embedded script sources snapshotted from the source craftbook, so the
   * task's gate/lifecycle scripts execute from its own copy — `scope:
   * 'craftbook'` refs resolve here first, project-installed copy second.
   */
  scripts: CraftbookScriptsSchema.optional(),
  /**
   * Declarative per-item fanout config, snapshotted from the source
   * craftbook so the runtime reads it at fanout time (the `spawnFanout`
   * step's activation reads `spawn.overFile` from the workspace). See
   * {@link CraftbookSpawnSchema}.
   */
  spawn: CraftbookSpawnSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Tier the embedded book was collapse-rendered for (D3). Stamped by
   * the tier-collapse pass at handoff dispatch; presence means "already
   * rendered — do not re-collapse". One-way in v1: gates are carried
   * verbatim, so a later re-route to a bigger model just walks fewer
   * steps.
   */
  renderedForTier: ModelTierSchema.optional(),
});
export type TaskCraftbook = z.infer<typeof TaskCraftbookSchema>;

/**
 * Provenance for a task's embedded craftbooks — which catalog template
 * and version each was copied from. `role: 'main'` corresponds to
 * `task.craftbook` (the recipe this task walks); `role: 'spawn'`
 * corresponds to `task.spawnsCraftbook` (the template cloned into
 * children for schedule-hosts and fanouts). Inline-steps tasks have an
 * empty array — they're task-native content with no source.
 */
export const TaskCraftbookSourceSchema = z.object({
  role: z.enum(['main', 'spawn']),
  catalogId: z.string(),
  version: z.string().optional(),
  /** Source identifier from the catalog (e.g. "bundled", "local"). */
  sourceId: z.string().optional(),
});
export type TaskCraftbookSource = z.infer<typeof TaskCraftbookSourceSchema>;

/* ─── Task outcomes ───────────────────────────────────────────────────── */

/**
 * A single expected outcome of a task: prose stating what should be
 * created or updated at successful completion (e.g. "An `index.html`
 * containing a playable snake game with score and a game-over screen").
 *
 * Structured as a list so each outcome can be individually verified — the
 * task's terminal verification step stamps `met` + `evidence` (an artifact
 * path or note) per outcome, and a completion gate (`checkOutcomesMet`)
 * can require every outcome to be met before the task closes.
 */
export const OutcomeSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  met: z.boolean().optional(),
  evidence: z.string().optional(),
  verifiedAt: z.string().optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

/* ─── Task ────────────────────────────────────────────────────────────── */

/**
 * Persisted task shape. `description` is permissive on read; the create
 * request enforces the min-40 length. `plan` is the voorman's evolving
 * approach — distinct from per-step notes and not every task needs one.
 *
 * Three shapes, derived from fields:
 *   - Regular task: `craftbook` set with own steps; `spawnsCraftbook` unset; `activeStepId` set.
 *   - Schedule host / pure spawn: `craftbook` is a minimal placeholder
 *     (e.g. one "wait for tick" step); `spawnsCraftbook` is the template
 *     cloned into children; `cron` set.
 *   - Coordinator: own `craftbook` AND `spawnsCraftbook` both meaningful.
 *
 * A child instance has `parentTaskRef` set to its host's ref.
 */
export const TaskSchema = z.object({
  projectId: z.string(),
  num: z.number().int().positive(),
  ref: z.string(),
  title: z.string(),
  description: z.string().optional(),
  plan: z.string().optional(),
  /**
   * Expected outcomes — prose of what should be created/updated at
   * successful completion, each individually verifiable. Authored during
   * planning; checked by the terminal verification step. See `OutcomeSchema`.
   */
  outcomes: z.array(OutcomeSchema).optional(),
  status: TaskStatusSchema,
  assignee: TaskAssigneeSchema,
  /**
   * The assignee was derived, not chosen — it mirrors whoever the ENTRY
   * step's `suggestedRole` resolved to. Set when a task is created
   * without a named assignee; cleared the moment anyone pins one.
   *
   * A draft carries the flag with an interim `{kind:'user'}` assignee:
   * drafts resolve no roles (that would create gezels for a task that
   * may never run), so `activate()` is the first moment a concrete
   * specialist exists to point at.
   */
  assigneeAuto: z.boolean().optional(),
  craftbook: TaskCraftbookSchema,
  spawnsCraftbook: TaskCraftbookSchema.optional(),
  sourceCraftbookIds: z.array(TaskCraftbookSourceSchema).optional(),
  /**
   * Invocation-time parameter values supplied when this task was
   * launched from a parameterized craftbook (the command launcher).
   * Stringified for the CLI round-trip; the declared types live on the
   * craftbook's `paramSchema`. Surfaced directly in every task-scoped
   * prompt so later specialists retain the authoritative inputs even when
   * an invocation path did not also stamp an entry-step note.
   */
  craftbookParams: z.record(z.string(), z.string()).optional(),
  /**
   * Invocation parameters for a schedule/fanout host's child template.
   * Copied to each spawned child's `craftbookParams`.
   */
  spawnsCraftbookParams: z.record(z.string(), z.string()).optional(),
  activeStepId: z.string().optional(),
  parentTaskRef: z.string().optional(),
  /**
   * Provenance for service-materialized tasks (today: project-type
   * schedule hosts). The dedup key that makes re-applying a type
   * idempotent — apply scans for a matching origin instead of creating a
   * second host. Deliberately absent from `CreateTaskRequestSchema`:
   * models and HTTP callers can't stamp it; only the service does, via
   * `TaskManager.create` extras.
   */
  origin: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('project-type-schedule'),
        typeId: z.string(),
        /** Schedule identity within the type — craftbook id, `#N`-suffixed on repeats. */
        scheduleKey: z.string(),
      }),
      z.object({
        /**
         * A durable control surface for work executed by the service
         * itself. `managedByGezelId` is presentation/provenance only:
         * the user assignee remains in place so TaskRunner never opens
         * a duplicate model session for the system loop.
         */
        kind: z.literal('system-job'),
        jobId: z.string(),
        managedByGezelId: z.string().optional(),
      }),
      z.object({
        /** A fix task linked back to one durable project-local BW issue. */
        kind: z.literal('boekwachter-issue'),
        issueRef: z.string().regex(/^BW-[1-9]\d*$/),
        path: z.string().min(1),
      }),
      z.object({
        /**
         * An invoke_craftbook call keyed to one persisted root chat turn.
         * The HTTP task boundary uses this opaque digest to return the first
         * still-active task when a provider continuation repeats the call.
         */
        kind: z.literal('craftbook-invocation'),
        key: z.string().regex(/^craftbook-root-v1:[a-f0-9]{64}$/),
      }),
      z.object({
        /**
         * A host materialized from a gezel template's `suggestedCraftbooks`
         * entry via the suggested-work layer. `suggestionKey` is the
         * entry's key within the template (`<craftbookId>` or
         * `<craftbookId>#N` on repeats) — together with `templateId` it is
         * the toggle identity: enable resurrects a matching paused host
         * instead of creating a second one.
         */
        kind: z.literal('gezel-suggested-craftbook'),
        templateId: z.string(),
        suggestionKey: z.string(),
      }),
    ])
    .optional(),
  cron: TaskCronSchema.optional(),
  nightShift: TaskNightShiftSchema.optional(),
  fanout: TaskFanoutSchema.optional(),
  /**
   * Handoff payload stamped by the most recent approving gate script.
   * Injected verbatim into the next step's handoff seed prompt (and
   * readable by scripts via `tasks.read`); replaced on each approval.
   */
  lastGateHandoff: z
    .object({
      fromStepId: z.string(),
      toStepId: z.string().optional(),
      message: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
      at: z.string(),
    })
    .optional(),
  /**
   * Naming presentation inherited from the session that launched this
   * workflow. Task handoffs create fresh sessions (and may be rehydrated
   * after restart), so they cannot rely on the launcher's session record
   * still being available when the next step starts.
   */
  roleBasedNameOnlyMode: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: TaskAssigneeSchema,
});
export type Task = z.infer<typeof TaskSchema>;

/* ─── Create / update requests ────────────────────────────────────────── */

/**
 * `description` is required at creation (min 40 chars). The idea is the
 * caller (usually the Meester) forces itself to state the job-to-be-done
 * in terms of what success looks like for the user — a voorman landing
 * on the task later can read it and actually know what they're solving.
 *
 * Exactly one of `craftbookId` (resolved from the catalog) or `steps`
 * (inline blueprint baked into an embedded ad-hoc craftbook) must be
 * provided for the main craftbook. The spawn-side is optional and
 * follows the same XOR; only meaningful when `cron` or `fanout` is
 * supplied.
 */
export const CreateTaskRequestSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(40),
    plan: z.string().optional(),
    outcomes: z.array(OutcomeSchema).optional(),
    /**
     * Who owns the task. Omit it on a craftbook whose entry step names a
     * `suggestedRole` and the resolved specialist becomes the assignee —
     * naming one here would only be an arbitrary pick that the role
     * resolution overrides at step level anyway. Falls back to the user
     * when nothing resolves. See `TaskSchema.assigneeAuto`.
     */
    assignee: TaskAssigneeSchema.optional(),
    /**
     * Initial status. Defaults to 'active'. Pass 'draft' to create an
     * inert task (e.g. a plan being authored) that won't tick or dispatch
     * until `activate`d. Drafts may not be schedule hosts.
     */
    status: z.enum(['draft', 'active']).optional(),
    /** Resolve the main craftbook from the catalog by id. */
    craftbookId: z.string().optional(),
    /** Catalog source id, when distinguishing local from bundled etc. */
    craftbookSourceId: z.string().optional(),
    /** Specific catalog version of the main craftbook. */
    craftbookVersion: z.string().optional(),
    /** Inline blueprint for the main craftbook (mutually exclusive with craftbookId). */
    steps: z.array(NewCraftbookStepSchema).optional(),
    /** Optional entry step id when supplying inline steps; defaults to first step. */
    entryStepId: z.string().optional(),
    /** Invocation-time param values for the main craftbook (launcher). */
    craftbookParams: z.record(z.string(), z.string()).optional(),
    /** Invocation-time param values copied to each spawned child. */
    spawnsCraftbookParams: z.record(z.string(), z.string()).optional(),
    /** Spawn-side (for schedule hosts and fanouts): catalog reference. */
    spawnsCraftbookId: z.string().optional(),
    spawnsCraftbookSourceId: z.string().optional(),
    spawnsCraftbookVersion: z.string().optional(),
    spawnsSteps: z.array(NewCraftbookStepSchema).optional(),
    spawnsEntryStepId: z.string().optional(),
    parentTaskRef: z.string().optional(),
    cron: z
      .object({
        expression: z.string(),
        overlap: TaskCronOverlapSchema.optional(),
      })
      .optional(),
    nightShift: z
      .object({
        enabled: z.boolean(),
        onceADay: z.boolean().optional(),
      })
      .optional(),
    fanout: NewTaskFanoutSchema.optional(),
    createdBy: TaskAssigneeSchema.optional(),
    /** Preserve the launcher's naming presentation across task handoffs. */
    roleBasedNameOnlyMode: z.boolean().optional(),
    /**
     * Enqueue the entry-step handoff immediately after create — the
     * single-channel kickoff (there is no "tell a gezel about work"
     * separate from "hand a gezel the work"). The worker starts in a
     * task-scoped session with the step prompt + gate contract
     * in-prompt. Invalid on drafts (they kick off via `activate`) and
     * on cron/fanout hosts (their children dispatch via their own
     * activation hooks — flag-dispatching the host would double-engage).
     */
    dispatchEntry: z.boolean().optional(),
    /**
     * Internal invoke_craftbook idempotency digest. The task route converts
     * it into service-owned Task.origin provenance; ordinary create_task
     * callers omit it.
     */
    craftbookInvocationKey: z
      .string()
      .regex(/^craftbook-root-v1:[a-f0-9]{64}$/)
      .optional(),
  })
  .refine((v) => !!v.craftbookId !== !!(v.steps && v.steps.length > 0), {
    message: 'exactly one of craftbookId or steps must be provided for the main craftbook',
    path: ['craftbookId'],
  })
  .refine(
    (v) => {
      const hasSpawnRef = !!v.spawnsCraftbookId;
      const hasSpawnInline = !!(v.spawnsSteps && v.spawnsSteps.length > 0);
      // Both unset is fine (no spawn side). One set is fine. Both set is not.
      return !(hasSpawnRef && hasSpawnInline);
    },
    {
      message: 'spawnsCraftbookId and spawnsSteps are mutually exclusive',
      path: ['spawnsCraftbookId'],
    },
  )
  .refine(
    (v) => {
      const hasSpawn = !!v.spawnsCraftbookId || !!(v.spawnsSteps && v.spawnsSteps.length > 0);
      // spawn-side only makes sense when this task spawns children.
      if (!hasSpawn) return true;
      return !!v.cron || !!v.fanout;
    },
    {
      message: 'spawn craftbook only valid when cron or fanout is set',
      path: ['spawnsCraftbookId'],
    },
  )
  .refine(
    (v) =>
      !v.spawnsCraftbookParams ||
      !!v.spawnsCraftbookId ||
      !!(v.spawnsSteps && v.spawnsSteps.length > 0),
    {
      message: 'spawn craftbook params require spawnsCraftbookId or spawnsSteps',
      path: ['spawnsCraftbookParams'],
    },
  )
  .refine((v) => v.status !== 'draft' || (!v.cron && !v.fanout), {
    message: 'a draft task cannot have a cron schedule or fanout',
    path: ['status'],
  })
  .refine((v) => v.dispatchEntry !== true || (v.status !== 'draft' && !v.cron && !v.fanout), {
    message:
      'dispatchEntry is only valid on an immediately-active, non-spawning task (drafts kick off via activate; cron/fanout children dispatch themselves)',
    path: ['dispatchEntry'],
  });
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const UpdateTaskRequestSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  plan: z.string().optional(),
  /** Expected outcomes. `null` clears them. See `OutcomeSchema`. */
  outcomes: z.array(OutcomeSchema).nullable().optional(),
  assignee: TaskAssigneeSchema.optional(),
  cron: z
    .object({
      expression: z.string(),
      overlap: TaskCronOverlapSchema.optional(),
    })
    .nullable()
    .optional(),
  nightShift: z
    .object({
      enabled: z.boolean(),
      onceADay: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  fanout: NewTaskFanoutSchema.nullable().optional(),
  /**
   * Replace a host's child-invocation params (copied to each spawned
   * child's `craftbookParams`). Only meaningful on spawn hosts; `null`
   * clears them.
   */
  spawnsCraftbookParams: z.record(z.string(), z.string()).nullable().optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;

export const SpawnTaskInstancesRequestSchema = z.object({
  count: z.number().int().positive().optional(),
  variations: z.array(TaskVariationSchema).optional(),
});
export type SpawnTaskInstancesRequest = z.infer<typeof SpawnTaskInstancesRequestSchema>;

export const SetTaskStatusRequestSchema = z.object({ status: TaskStatusSchema });
export type SetTaskStatusRequest = z.infer<typeof SetTaskStatusRequestSchema>;

export const CompleteStepRequestSchema = z.object({
  next: z.string().optional(),
  /**
   * Bypass the step's completion gate. User-only affordance (the UI's
   * "Complete anyway"); the MCP tool deliberately does not expose it.
   */
  force: z.boolean().optional(),
});
export type CompleteStepRequest = z.infer<typeof CompleteStepRequestSchema>;

/**
 * Result of a gated completion attempt. When the gate rejects, `task` is
 * the (unchanged-active-step) task and `gate` carries the prescriptive
 * rejection for the caller to surface.
 */
export const CompleteStepGateInfoSchema = z.object({
  decision: z.literal('reject'),
  message: z.string(),
  /** Zero means the gate infrastructure failed before judging the deliverable. */
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  paused: z.boolean(),
  infrastructureError: z.boolean().optional(),
  scriptRuns: z
    .array(
      z.object({
        scriptName: z.string(),
        runId: z.string().optional(),
        error: z.string().optional(),
        logsTail: z.string().optional(),
      }),
    )
    .optional(),
});
export type CompleteStepGateInfo = z.infer<typeof CompleteStepGateInfoSchema>;

export const CompleteStepResponseSchema = z.object({
  task: TaskSchema,
  gate: CompleteStepGateInfoSchema.optional(),
});
export type CompleteStepResponse = z.infer<typeof CompleteStepResponseSchema>;

/**
 * Patch a single embedded step's mutable fields. `undefined` leaves a
 * field untouched; `null` (on the nullable fields) clears it. Mirrors
 * `UpdateTaskRequest`'s nullable-vs-undefined semantics.
 *
 * Covers the FULL craftbook-step surface (not just description/prompt/
 * assignee) so the shared craftbook editor can drive a task's embedded
 * craftbook exactly like a standalone template — relabel, re-role, and
 * rewire routing/gates/auto-advance. Edits that touch edges
 * (`next`/`branches`/`gate`/`terminal`/`advanceWhen`) are graph-validated
 * after merge.
 */
export const UpdateTaskStepRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  suggestedRole: z.string().nullable().optional(),
  assignee: TaskAssigneeSchema.nullable().optional(),
  suggestedGezelId: z.string().nullable().optional(),
  /** Step automation hooks (single ref or ordered list). `null` detaches. */
  onEnter: ScriptRefListSchema.nullable().optional(),
  onExit: ScriptRefListSchema.nullable().optional(),
  /** Required file inputs for the step. `null` clears the declaration. */
  consumes: z.array(CraftbookStepInputSchema).min(1).nullable().optional(),
  /** Auto-advance contract. `null` clears it. */
  advanceWhen: AdvanceWhenSchema.nullable().optional(),
  /** The end-of-step gate (current or legacy shape). `null` clears it. */
  gate: StepGateUnionSchema.nullable().optional(),
  /** Default outgoing edge (step id). `null` clears it. */
  next: z.string().nullable().optional(),
  /** Conditional routing. `null` clears it. */
  branches: z.array(CraftbookBranchSchema).nullable().optional(),
  /** Whether this step ends the craftbook. */
  terminal: z.boolean().optional(),
});
export type UpdateTaskStepRequest = z.infer<typeof UpdateTaskStepRequestSchema>;

export const UpdateTaskStepResponseSchema = z.object({
  task: TaskSchema,
});
export type UpdateTaskStepResponse = z.infer<typeof UpdateTaskStepResponseSchema>;

/**
 * Patch the overall metadata of a task's embedded craftbook (its
 * name/description/plan/defaultAssignee) and its `entryStepId`. The
 * craftbook *structure* (steps) is edited via the step routes; this is
 * the book-level surface. `undefined` leaves a field untouched; `null`
 * clears the nullable ones.
 */
export const UpdateTaskCraftbookRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  defaultAssignee: TaskAssigneeSchema.nullable().optional(),
  entryStepId: z.string().optional(),
});
export type UpdateTaskCraftbookRequest = z.infer<typeof UpdateTaskCraftbookRequestSchema>;

export const NewTaskStepSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().optional(),
  suggestedGezelId: z.string().optional(),
  assignee: TaskAssigneeSchema.optional(),
});
export type NewTaskStep = z.infer<typeof NewTaskStepSchema>;

export const ListTasksResponseSchema = z.object({
  tasks: z.array(TaskSchema),
});
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;

export const TaskResponseSchema = TaskSchema;
export type TaskResponse = z.infer<typeof TaskResponseSchema>;

/* ─── Task notes ──────────────────────────────────────────────────────── */

export const TaskNoteAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gezel'), gezelId: z.string(), name: z.string() }),
  z.object({ kind: z.literal('user') }),
]);
export type TaskNoteAuthor = z.infer<typeof TaskNoteAuthorSchema>;

export const TaskNoteSchema = z.object({
  id: z.string(),
  at: z.string(),
  author: TaskNoteAuthorSchema,
  stepId: z.string().optional(),
  text: z.string(),
});
export type TaskNote = z.infer<typeof TaskNoteSchema>;

export const ListTaskNotesResponseSchema = z.object({
  notes: z.array(TaskNoteSchema),
});
export type ListTaskNotesResponse = z.infer<typeof ListTaskNotesResponseSchema>;

export const AppendTaskNoteRequestSchema = z.object({
  text: z.string().min(1),
  stepId: z.string().optional(),
});
export type AppendTaskNoteRequest = z.infer<typeof AppendTaskNoteRequestSchema>;

export const AppendTaskNoteResponseSchema = z.object({
  note: TaskNoteSchema,
});
export type AppendTaskNoteResponse = z.infer<typeof AppendTaskNoteResponseSchema>;

export const UpdateTaskNoteRequestSchema = z.object({
  text: z.string().min(1),
});
export type UpdateTaskNoteRequest = z.infer<typeof UpdateTaskNoteRequestSchema>;

export const UpdateTaskNoteResponseSchema = z.object({
  note: TaskNoteSchema,
});
export type UpdateTaskNoteResponse = z.infer<typeof UpdateTaskNoteResponseSchema>;

/* ─── Helpers ─────────────────────────────────────────────────────────── */

/** Build the stable `projectId/num` ref string used across UI, MCP, HTTP. */
export function taskRef(projectId: string, num: number): string {
  return `${projectId}/${num}`;
}

/** Parse a `projectId/num` ref. Returns null if the shape doesn't match. */
export function parseTaskRef(ref: string): { projectId: string; num: number } | null {
  const idx = ref.lastIndexOf('/');
  if (idx < 0 || idx === ref.length - 1) return null;
  const projectId = ref.slice(0, idx);
  const numStr = ref.slice(idx + 1);
  if (!projectId) return null;
  const num = Number.parseInt(numStr, 10);
  if (!Number.isFinite(num) || num <= 0 || String(num) !== numStr) return null;
  return { projectId, num };
}

/** Canonical `projectId/num` task reference accepted at API/tool boundaries. */
export const TaskRefSchema = z.string().refine((ref) => parseTaskRef(ref) !== null, {
  message: 'task ref must use projectId/num form',
});

/**
 * A schedule host is a task whose primary purpose is spawning children
 * — it has a `spawnsCraftbook` template and a `cron` schedule.
 */
export function isScheduleHost(task: Task): boolean {
  return !!task.spawnsCraftbook && !!task.cron;
}

/**
 * A draft task: created but inert. Not ticked by the scheduler, never
 * dispatches a handoff, and not counted as pending "active" work — until
 * activated (draft → active via `TaskManager.activate`).
 */
export function isDraftTask(task: { status: TaskStatus }): boolean {
  return task.status === 'draft';
}

/**
 * A task that spawns children via cron or fanout (regardless of whether
 * it has its own meaningful main work).
 */
export function spawnsChildren(task: Task): boolean {
  return !!task.spawnsCraftbook && (!!task.cron || !!task.fanout);
}

/** A task deferred to Night Shift mode (only dispatches while the shift is ON). */
export function isNightShiftTask(task: Task): boolean {
  return task.nightShift?.enabled === true;
}

/**
 * Whether a night-shift task still has work to do on `today` (a local
 * 'YYYY-MM-DD' date). Drives the manager's "are there pending night-shift
 * tasks?" sweep and its drain-then-latch decision. A `onceADay` task that
 * already ran today is no longer pending.
 */
export function isPendingNightShiftTask(task: Task, today: string): boolean {
  if (task.status !== 'active') return false;
  if (!isNightShiftTask(task)) return false;
  // A cron/fanout schedule host isn't itself workable — its spawned
  // children are the night-shift work. Counting the host as "pending"
  // would keep the shift from ever latching off (the host stays active
  // forever), so exclude it.
  if (spawnsChildren(task)) return false;
  if (task.nightShift?.onceADay && task.nightShift.lastRunDay === today) return false;
  return true;
}
