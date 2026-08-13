import { createHash, randomUUID } from 'node:crypto';
import {
  type ChatSessionSummary,
  type Craftbook,
  type CraftbookConnectorNeed,
  type CraftbookStep,
  type CraftbookToolsetNeed,
  type CreateTaskRequest,
  DEFAULT_NIGHT_SHIFT_WINDOW,
  type GateAttemptRecord,
  type GateScriptRef,
  type GezelConfig,
  MANAGED_WORKSPACE_WRITE_SETTING_LABEL,
  type NewCraftbookStep,
  type NormalizedStepGate,
  type ScriptOutputPredicate,
  type ScriptRef,
  type ScriptRun,
  type StepPosition,
  type Task,
  type TaskAssignee,
  type TaskCraftbook,
  type TaskCraftbookSource,
  type TaskCraftbookStep,
  type TaskFanout,
  type TaskNote,
  type TaskNoteAuthor,
  type TaskStatus,
  type TaskVariation,
  type UpdateTaskRequest,
  type UpdateTaskStepRequest,
  applyStepPatch,
  assertCraftbookGraph,
  taskRef as buildTaskRef,
  createLogger,
  expandStepDeliverable,
  expandStepDeliverables,
  isEngagementAllowed,
  nightShiftDayKey,
  normalizeScriptRefs,
  normalizeStepGate,
  nowIso,
  parseTaskRef,
  planGuardrails,
  projectManagedWorkspaceWritable,
  removeStepAndCleanEdges,
  reorderStepsArray,
  resolveSecurityPolicy,
  resolveSteps,
  stepInsertionIndex,
  summarizePlanDocument,
  uniqueStepId,
  unmetConnectors,
  unmetToolsets,
} from '@bendyline/gezel';
import { collapseCraftbookForTier as collapseCraftbookPass } from '@bendyline/gezel';
import { evaluateDeliverableGate } from '../chat/deliverable-gate.js';
import { installedToolsetIds } from '../craftbook/applicable.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { ScriptRunner } from '../scripts/runner.js';
import { nextCronFire, parseCron } from './cron.js';
import {
  type EscalationStage,
  appendGateAttempt,
  buildPlateauDiagnosisNote,
  buildStageOneNudge,
  buildStageTwoNudge,
  escalationDisabled,
  gateFailureSignature,
  plateauScore,
  stageForPlateau,
} from './gate-escalation.js';
import { type GateCheckOutcome, type GateWorkspaceReader, gateCheckLabel } from './gate-eval.js';
import { execNodeRunsInSandbox } from './node-runs-exec.js';
import { type StepGateOutcome, evaluateStepGate, gateMessageFingerprint } from './step-gate.js';

const log = createLogger('tasks');

/**
 * Resolves a craftbook id to a runtime `Craftbook`. Implementation lives
 * in `service.ts` and bridges to the local Store + the `CatalogService`
 * — keeping the TaskManager itself catalog-unaware lets unit tests pass
 * a tiny stub.
 */
export interface CraftbookResolver {
  resolve(
    id: string,
    opts?: { version?: string; sourceId?: string; projectId?: string },
  ): Promise<{
    craftbook: Craftbook;
    sourceId: string;
    version?: string;
  } | null>;
}

/** A craftbook was selected correctly, but its declared runtime is not ready. */
export class CraftbookSetupRequiredError extends Error {
  readonly code = 'CRAFTBOOK_SETUP_REQUIRED';

  constructor(
    readonly craftbookId: string,
    readonly missingToolsets: CraftbookToolsetNeed[],
  ) {
    const details = missingToolsets
      .map((need) => `${need.toolsetId}${need.reason ? ` (${need.reason})` : ''}`)
      .join(', ');
    super(
      `SETUP REQUIRED for craftbook "${craftbookId}": install/configure ${details} before creating this task. No task was created.`,
    );
    this.name = 'CraftbookSetupRequiredError';
  }
}

/**
 * A craftbook reads a connector corpus the project has not bound. The
 * launcher offers to bind it (defaults come from the project) and retries.
 */
export class ConnectorSetupRequiredError extends Error {
  readonly code = 'CONNECTOR_SETUP_REQUIRED';

  constructor(
    readonly craftbookId: string,
    readonly missingConnectors: CraftbookConnectorNeed[],
  ) {
    const details = missingConnectors
      .map((need) => `${need.typeId}${need.reason ? ` (${need.reason})` : ''}`)
      .join(', ');
    super(
      `SETUP REQUIRED for craftbook "${craftbookId}": connect ${details} before creating this task. No task was created.`,
    );
    this.name = 'ConnectorSetupRequiredError';
  }
}

/**
 * The data a connector pulled down for one task launch: params to merge
 * into `craftbookParams` (so `{{corpusScope}}` and friends interpolate
 * into step prompts and gate paths) and a note for the audit trail.
 */
export interface ConnectorPrepResult {
  params?: Record<string, string>;
  note?: string;
}

/**
 * Runs a craftbook's declared connectors before its first step. Kept as a
 * hook rather than a direct dependency so `TaskManager` stays free of the
 * connector subsystem — `service.ts` wires the real implementation once
 * `ConnectorManager` exists.
 *
 * This is the runtime-initiated half of the connector contract: a gezel
 * never calls a "fetch" tool (docs/connector-standards.md), so the data
 * has to be on disk before the step prompt is built.
 */
export type ConnectorPrepHook = (ctx: {
  projectId: string;
  craftbookId: string;
  connectors: CraftbookConnectorNeed[];
  params: Record<string, string>;
}) => Promise<ConnectorPrepResult>;

function describeAssignee(
  a: TaskAssignee,
  resolveGezelName: (id: string) => string | undefined,
): string {
  if (a.kind === 'user') return 'the user';
  return resolveGezelName(a.gezelId) ?? a.gezelId;
}

/**
 * Produce a TaskCraftbook from a runtime Craftbook by stamping
 * `createdAt` on every step. Used both when resolving from the catalog
 * (the embedded copy gets fresh per-instance lifecycle fields) and when
 * cloning a parent's spawn craftbook into a child.
 */
function snapshotCraftbookForTask(book: Craftbook, now: string): TaskCraftbook {
  return {
    id: book.id,
    name: book.name,
    ...(book.description ? { description: book.description } : {}),
    ...(book.version ? { version: book.version } : {}),
    ...(book.basedOn ? { basedOn: book.basedOn } : {}),
    ...(book.plan ? { plan: book.plan } : {}),
    ...(book.defaultAssignee ? { defaultAssignee: book.defaultAssignee } : {}),
    steps: book.steps.map(
      (s): TaskCraftbookStep => ({
        ...s,
        createdAt: now,
      }),
    ),
    entryStepId: book.entryStepId,
    // Snapshot triggers + hooks too so ChatManager's bridge-side hook
    // installer (which reads `task.craftbook.hooks`) sees them. Without
    // this the catalog resolver's propagation is silently dropped at
    // snapshot time and any craftbook that ships a `hooks` block (e.g.
    // community books declaring a `PreToolUse` destructive-command
    // guard) silently fails to install its hooks.
    ...(book.triggers ? { triggers: book.triggers } : {}),
    ...(book.hooks ? { hooks: book.hooks } : {}),
    ...(book.paramSchema ? { paramSchema: book.paramSchema } : {}),
    // Snapshot toolsets so ChatManager can derive the auto-allow tool set
    // from `task.craftbook.toolsets` without re-resolving the catalog book.
    ...(book.toolsets ? { toolsets: book.toolsets } : {}),
    // Snapshot connector needs so a running task records the corpus it was
    // launched against without re-resolving the catalog book.
    ...(book.connectors ? { connectors: book.connectors } : {}),
    // Snapshot embedded script sources so the task's gate/lifecycle
    // scripts execute from its own copy (scope 'craftbook' refs resolve
    // here first — see runGateScript/runStepScript).
    ...(book.scripts ? { scripts: book.scripts } : {}),
    // Snapshot the declarative per-item fanout config so the runtime reads
    // `task.craftbook.spawn` when the `spawnFanout` step activates.
    ...(book.spawn ? { spawn: book.spawn } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Read scalar string defaults from a craftbook's permissive JSON schema. */
function craftbookParamDefaults(paramSchema: Craftbook['paramSchema']): Record<string, string> {
  const properties = (
    paramSchema && typeof paramSchema.properties === 'object' && paramSchema.properties !== null
      ? paramSchema.properties
      : {}
  ) as Record<string, unknown>;
  const defaults: Record<string, string> = {};
  for (const [key, raw] of Object.entries(properties)) {
    if (!raw || typeof raw !== 'object') continue;
    const value = (raw as { default?: unknown }).default;
    if (typeof value === 'string') defaults[key] = value;
  }
  return defaults;
}

/**
 * Substitute `{{ key }}` placeholders with per-child context values.
 * Plain string substitution only — no templating engine (mirrors the
 * `TaskVariation.context` contract). Unknown placeholders are left intact
 * so a template typo is visible, not silently blanked. This is what lands
 * the per-item data (`{{client}}`, `{{number}}`, …) in a declarative-fanout
 * child's step prompt, declared inputs, AND its gate/advanceWhen file paths, so a child that
 * writes `invoices/{{number}}.html` is gated against that exact file.
 */
function interpolateContext(text: string, context: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(context, key) ? context[key]! : whole,
  );
}

/**
 * Apply {@link interpolateContext} across the text-bearing fields of a
 * child craftbook's steps: name/description/prompt plus the file paths in
 * `advanceWhen` and every gate check. The step objects themselves are
 * fresh snapshot copies, but their NESTED `advanceWhen`/`gate` are still
 * aliased to the source book (`snapshotCraftbookForTask` shallow-spreads
 * each step) — so those are replaced copy-on-write, never mutated in
 * place, or the substitution would write through into the resolver's
 * template and leak one task's params into the next. Non-fatal by
 * construction — only string fields are touched.
 */
function interpolateStepsContext(
  steps: TaskCraftbookStep[],
  context: Record<string, string>,
): void {
  if (Object.keys(context).length === 0) return;
  for (const step of steps) {
    if (step.name) step.name = interpolateContext(step.name, context);
    if (step.description) step.description = interpolateContext(step.description, context);
    if (step.prompt) step.prompt = interpolateContext(step.prompt, context);
    if (step.consumes?.length) {
      step.consumes = step.consumes.map((input) => ({
        ...input,
        file: interpolateContext(input.file, context),
      }));
    }
    if (step.advanceWhen?.file) {
      step.advanceWhen = {
        ...step.advanceWhen,
        file: interpolateContext(step.advanceWhen.file, context),
      };
    }
    const gate = step.gate as { checks?: Array<Record<string, unknown>> } | undefined;
    if (gate?.checks?.some((check) => typeof check.file === 'string')) {
      step.gate = {
        ...gate,
        checks: gate.checks.map((check) =>
          typeof check.file === 'string'
            ? { ...check, file: interpolateContext(check.file, context) }
            : check,
        ),
      } as typeof step.gate;
    }
  }
}

/**
 * Turn an array of inline-step blueprints into a fresh ad-hoc craftbook.
 * Used when `create_task` is called with `steps` instead of a
 * `craftbookId` — the resulting book is embedded directly in the task
 * with no source provenance.
 */
function inlineStepsToCraftbook(
  steps: NewCraftbookStep[],
  opts: {
    name: string;
    description?: string;
    plan?: string;
    defaultAssignee?: TaskAssignee;
    entryStepId?: string;
  },
): Craftbook {
  const resolved: CraftbookStep[] = expandStepDeliverables(steps);
  const ids = new Set(resolved.map((s) => s.id));
  const entry = opts.entryStepId && ids.has(opts.entryStepId) ? opts.entryStepId : resolved[0]!.id;
  const now = nowIso();
  return {
    id: `task-${randomUUID().slice(0, 8)}`,
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.plan ? { plan: opts.plan } : {}),
    ...(opts.defaultAssignee ? { defaultAssignee: opts.defaultAssignee } : {}),
    steps: resolved,
    entryStepId: entry,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Fires after `completeStep` activates a new step. Allows the caller
 * (service.ts wires this into `ChatManager.startHandoffSession`) to
 * auto-start a session for the new assignee without creating a circular
 * TaskManager ↔ ChatManager dependency.
 *
 * The hook is fire-and-forget from the task manager's perspective — any
 * failure inside the hook is logged by the hook itself and must not
 * propagate back into `completeStep`.
 */
export type StepActivatedHook = (ctx: {
  projectId: string;
  task: Task;
  /** The freshly-activated step. */
  newStep: TaskCraftbookStep;
  /** The step that was just completed (may equal newStep on loopback). */
  completedStep: TaskCraftbookStep;
}) => Promise<void> | void;

/**
 * Fired when a completion gate re-activates a step but the model turn that
 * triggered the gate remains responsible for the repair. The task runner uses
 * this to transfer its live dispatch to the fresh activation instead of
 * mistaking the timestamp change for superseding work and cancelling the turn.
 *
 * Deliberately synchronous: it runs immediately after the task write, before
 * any awaited history/project work gives the runner's pruning timer a chance
 * to observe the new activation without its current-turn ownership.
 */
export type CurrentTurnStepReactivatedHook = (ctx: {
  projectId: string;
  task: Task;
  newStep: TaskCraftbookStep;
  gatedStep: TaskCraftbookStep;
}) => void;

/**
 * Fired once after a task is created and written to disk. Used by
 * `service.ts` to install a craftbook's bundled scripts into the
 * project's scripts/ folder so onEnter/onExit refs resolve on first
 * run. Failure inside the hook is logged + non-fatal — the task is
 * already created either way.
 */
export type TaskCreatedHook = (ctx: {
  projectId: string;
  task: Task;
  /** Catalog provenance of the craftbook(s) on this task, when known. */
  sources: TaskCraftbookSource[];
}) => Promise<void> | void;

/**
 * Fired after a task reaches a terminal status. Feature modules can attach
 * durable cleanup to real task completion without polling UI state.
 */
export type TaskSettledHook = (ctx: {
  projectId: string;
  task: Task;
  outcome: 'complete' | 'canceled';
}) => Promise<void> | void;

export type TaskNeedsHelpReason =
  | 'gate_exhausted'
  | 'gate_plateau'
  | 'gate_unsatisfiable'
  | 'gate_infrastructure'
  | 'step_stalled'
  | 'budget_exhausted';

/**
 * Fired when a task PAUSES FOR HELP — a gate budget spent, a plateau, an
 * unsatisfiable-by-policy gate, a stalled assignee. Settle hooks only
 * cover complete/canceled, so without this a background task that hit a
 * wall paused silently: a note on the task and a history row, nothing
 * pushed to the user. `detail` is a one-line human summary of why.
 */
export type TaskNeedsHelpHook = (ctx: {
  projectId: string;
  task: Task;
  stepId?: string;
  reason: TaskNeedsHelpReason;
  detail: string;
}) => Promise<void> | void;

/**
 * Resolves a craftbook step's `suggestedRole` into a concrete gezel id
 * (via roster reuse or gilde-template creation). Wired by `service.ts`
 * around `ensureGezel`. When unset, role-based auto-assignment is a
 * no-op and the step keeps whatever assignee was set explicitly. Errors
 * are caught and treated as "no resolution" so a misconfigured wiring
 * doesn't block step activation.
 */
export type RoleResolver = (role: string, projectId: string) => Promise<{ gezelId: string } | null>;

/**
 * The gezel a step is bound to on its OWN terms — an explicit assignee,
 * else the gezel its `suggestedRole` resolved into. Deliberately does not
 * consult the task-level assignee: this is the function that feeds it.
 *
 * Mirrors the precedence the handoff paths use (`onStepActivated` reads
 * the step binding, never the task assignee), so a derived task owner and
 * the gezel actually holding the step can't disagree.
 */
function stepOwnAssignee(
  craftbook: { steps: TaskCraftbookStep[] },
  stepId: string | undefined,
): TaskAssignee | null {
  if (!stepId) return null;
  const step = craftbook.steps.find((s) => s.id === stepId);
  if (!step) return null;
  if (step.assignee) return step.assignee;
  if (step.suggestedGezelId) return { kind: 'gezel', gezelId: step.suggestedGezelId };
  return null;
}

/**
 * Maximum number of steps that can auto-advance in a single
 * `completeStep` call chain. Protects against a script whose
 * `autoAdvanceOnSuccess` (or branch predicate) fires every time but
 * never converges — the task pauses when the cap trips.
 */
const STEP_CASCADE_CAP = 10;

export interface CompleteStepOpts {
  /** Bypass the step's completion gate (user-only affordance). */
  force?: boolean;
  /**
   * Who initiated the completion. `'gate'` marks runtime routing that is
   * itself a CONSEQUENCE of a gate decision — the guard must not re-fire
   * on it. `'auto'` marks onEnter-cascade advances (still gate-guarded).
   * `'sweep'` marks the idle-step supervisor's evidence-based retry —
   * gate-guarded, but it must not climb the escalation ladder (nobody is
   * resubmitting; the sweep is just re-checking a stale deliverable).
   */
  cause?: 'gate' | 'user' | 'model' | 'auto' | 'sweep';
}

export interface GateHoldInfo {
  /** The prescriptive rejection text for the working session. */
  message: string;
  /** Stable fingerprint of `message` for nudge dedup. */
  messageFingerprint: string;
  attempt: number;
  maxAttempts: number;
  /** True when the rejection budget is exhausted and the task paused. */
  paused: boolean;
  /** True when this is the damped replay of an earlier rejection. */
  cached: boolean;
  /** The gate runtime/configuration failed; no deliverable attempt was charged. */
  infrastructureError?: true;
  /**
   * The rejection cannot be repaired by any assignee under current policy
   * (a failing workspace-tree check while gezel workspace writes are off
   * for the project). No deliverable attempt was charged; the task paused
   * for a human decision instead of climbing the escalation ladder.
   */
  unsatisfiable?: true;
  /** Script-run identifiers and redacted log tails for gate infrastructure failures. */
  scriptRuns?: StepGateOutcome['runs'];
  /** Per-check structured outcomes from the gate's declarative floor. */
  checkResults?: GateCheckOutcome[];
  /**
   * Plateau-escalation rung this hold was delivered at (1 targeted-edit,
   * 2 full-rewrite, 3 paused-with-diagnosis). Absent/0 = plain rejection.
   * When ≥1 the `message` IS the stage directive — deliver it raw.
   */
  escalationStage?: EscalationStage;
}

export type CompleteStepOutcome =
  | { status: 'advanced'; task: Task }
  | { status: 'held'; task: Task; gate: GateHoldInfo };

function formatGateScriptDiagnostics(runs: StepGateOutcome['runs']): string {
  return runs
    .filter((run) => run.error || run.logsTail)
    .map((run) => {
      const lines = [`- Script: \`${run.scriptName}\``];
      if (run.runId) lines.push(`  - Run ID: \`${run.runId}\``);
      if (run.error) lines.push(`  - Error: ${run.error}`);
      if (run.logsTail) lines.push(`  - Log tail:\n\n    \`\`\`\n${run.logsTail}\n    \`\`\``);
      return lines.join('\n');
    })
    .join('\n');
}

/** Thrown by the legacy `completeStep` wrapper when a gate holds the step. */
export class GateRejectionError extends Error {
  constructor(
    readonly gate: GateHoldInfo,
    readonly task: Task,
  ) {
    super(`step completion held by gate: ${gate.message.split('\n')[0] ?? ''}`);
    this.name = 'GateRejectionError';
  }
}

export class TaskManager {
  private onStepActivated?: StepActivatedHook;
  private onCurrentTurnStepReactivated?: CurrentTurnStepReactivatedHook;
  private onTaskCreated?: TaskCreatedHook;
  private onTaskSettled?: TaskSettledHook;
  private onTaskNeedsHelp?: TaskNeedsHelpHook;
  private onConnectorPrep?: ConnectorPrepHook;
  private readonly autoPreparedConnectorTypes = new Set<string>();
  private scriptRunner?: ScriptRunner;
  private craftbookResolver?: CraftbookResolver;
  private roleResolver?: RoleResolver;
  /**
   * Join concurrent replays of the same step transition. Local models can
   * retry an MCP call when its response is slow; without single-flight both
   * requests read the same active step and independently run gates, scripts,
   * recruitment, and handoff hooks before either write becomes visible.
   */
  private readonly inFlightStepCompletions = new Map<string, Promise<CompleteStepOutcome>>();

  constructor(
    private readonly store: Store,
    private readonly history?: HistoryManager,
  ) {}

  /**
   * Wake a project that was resting in `stable` because live work just
   * happened on it (a task created, resumed, reassigned, advanced to a
   * new step, or edited — anything that ISN'T closing/completing). Per
   * the lifecycle rule: any such op flips the project back to `active`.
   *
   * Deliberately ONLY touches `stable`. `readonly` / `inactive` are
   * explicit user pauses — a task edit must not silently override the
   * user's "I parked this project" choice. `stable` is the soft,
   * lifecycle-owned state, so it's ours to clear.
   */
  private async reactivateProject(projectId: string): Promise<void> {
    try {
      const project = await this.store.getProject(projectId);
      if (project?.status === 'stable') {
        await this.store.updateProject(projectId, { status: 'active' });
      }
    } catch (err) {
      log.error('[tasks] reactivateProject failed:', err);
    }
  }

  /**
   * A task just went terminal (complete/canceled). If the project is
   * otherwise live (`active`/unset) and has no remaining `active` tasks,
   * it has come to rest — mark it `stable` so the scheduler stops firing
   * "anything stuck?" check-ins at a finished project (the qwen3.6
   * "Space Shooter Arcade" spin: nagged a closed-and-verified project
   * until the model melted down). Reversible via {@link reactivateProject}.
   *
   * Leaves `readonly`/`inactive` alone (deliberate user pauses) and is a
   * no-op when any task is still `active` (the project still has work).
   *
   * Public (not just a `setStatus` hook) because the nudge scheduler
   * also calls it to self-heal projects stuck `active` with no active
   * tasks — see `TaskScheduler.maybeNudge`.
   */
  async maybeStabilizeProject(projectId: string): Promise<void> {
    try {
      const project = await this.store.getProject(projectId);
      const status = project?.status ?? 'active';
      if (status !== 'active') return;
      const tasks = await this.store.listProjectTasks(projectId);
      // A draft is pending work (a plan waiting to be activated), so it
      // blocks stabilization just like an active task — otherwise a project
      // whose only task is a fresh draft would go `stable` and stop nudging.
      if (tasks.length > 0 && !tasks.some((t) => t.status === 'active' || t.status === 'draft')) {
        await this.store.updateProject(projectId, { status: 'stable' });
      }
    } catch (err) {
      log.error('[tasks] maybeStabilizeProject failed:', err);
    }
  }

  /**
   * Inject the ScriptRunner after construction to avoid a circular
   * dependency at service boot time. Scripts attached to steps via
   * `onEnter` / `onExit` are only executed when this has been set.
   */
  setScriptRunner(runner: ScriptRunner): void {
    this.scriptRunner = runner;
  }

  /**
   * Inject a craftbook resolver. When unset, `create()` only accepts
   * inline `steps` — `craftbookId` lookups will fail with a clear
   * error. Tests that don't exercise the catalog can skip this.
   */
  setCraftbookResolver(resolver: CraftbookResolver): void {
    this.craftbookResolver = resolver;
  }

  /** Register the auto-handoff hook. Only one hook is supported. */
  setStepActivatedHook(fn: StepActivatedHook): void {
    this.onStepActivated = fn;
  }

  /** Register the current-turn gate-loop ownership hook. */
  setCurrentTurnStepReactivatedHook(fn: CurrentTurnStepReactivatedHook): void {
    this.onCurrentTurnStepReactivated = fn;
  }

  /**
   * Wire the Keurmeester supervision engine. Set by service.ts after
   * both exist (cycle avoidance, same as setScriptRunner). When set,
   * the completion gate consults it before pausing an exhausted step,
   * and step completions close its open intervention cases.
   */
  setKeurmeester(keurmeester: import('../keurmeester/manager.js').KeurmeesterManager): void {
    this.keurmeester = keurmeester;
  }
  private keurmeester?: import('../keurmeester/manager.js').KeurmeesterManager;
  /**
   * Per-(task, step) judge-call budget for `judge` gate checks — a
   * reject-loop must not burn frontier spend on every attempt. Reset
   * on gate approve.
   */
  private readonly judgeCallCounts = new Map<string, number>();

  /** Register the task-created hook (script install lives here). */
  setTaskCreatedHook(fn: TaskCreatedHook): void {
    this.onTaskCreated = fn;
  }

  setTaskSettledHook(fn: TaskSettledHook): void {
    this.onTaskSettled = fn;
  }

  setTaskNeedsHelpHook(fn: TaskNeedsHelpHook): void {
    this.onTaskNeedsHelp = fn;
  }

  /**
   * Wire the connector-prep hook — pulls a craftbook's declared connector
   * data down before its first step runs. Unset = connector needs are
   * still enforced (a required, unbound connector fails the launch), but
   * nothing syncs.
   */
  setConnectorPrepHook(
    fn: ConnectorPrepHook,
    opts: { autoPreparedTypes?: readonly string[] } = {},
  ): void {
    this.onConnectorPrep = fn;
    this.autoPreparedConnectorTypes.clear();
    for (const typeId of opts.autoPreparedTypes ?? []) {
      this.autoPreparedConnectorTypes.add(typeId);
    }
  }

  /**
   * Fire the needs-help hook (fire-and-forget, errors logged). Public so
   * the scheduler's stalled-step escalation can report through the same
   * channel as the gate pauses.
   */
  async emitNeedsHelp(ctx: {
    projectId: string;
    task: Task;
    stepId?: string;
    reason: TaskNeedsHelpReason;
    detail: string;
  }): Promise<void> {
    if (!this.onTaskNeedsHelp) return;
    try {
      await this.onTaskNeedsHelp(ctx);
    } catch (err) {
      log.warn(
        `[tasks] needs-help hook failed for ${ctx.task.ref}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  private async notifyTaskSettled(task: Task, outcome: 'complete' | 'canceled'): Promise<void> {
    if (!this.onTaskSettled) return;
    try {
      await this.onTaskSettled({ projectId: task.projectId, task, outcome });
    } catch (err) {
      log.warn(
        `[tasks] terminal hook failed for ${task.ref}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Wire the role resolver — turns a step's `suggestedRole` into a
   * concrete gezel id at step-activation time. When unset, role-based
   * auto-assignment is a no-op (steps with `suggestedRole` but no
   * `suggestedGezelId` / `assignee` fall through to the task-level
   * assignee). `service.ts` calls this with a wrapper around
   * `ensureGezel`.
   */
  setRoleResolver(fn: RoleResolver): void {
    this.roleResolver = fn;
  }

  /**
   * Mutating helper: if the named step has `suggestedRole` set and no
   * higher-precedence assignment (`assignee.kind === 'gezel'` or
   * `suggestedGezelId`), resolve the role into a gezel id and stamp it
   * onto the step. Mutates the step in-place (the embedded craftbook
   * snapshot lives on the task and is rewritten by the caller).
   *
   * Resolution errors are logged + swallowed — a misconfigured resolver
   * leaves the step alone, which falls back to the task-level assignee.
   * Better than blocking step activation.
   */
  private async maybeResolveStepRole(
    craftbook: { steps: TaskCraftbookStep[] },
    stepId: string,
    projectId: string,
  ): Promise<void> {
    if (!this.roleResolver) return;
    const step = craftbook.steps.find((s) => s.id === stepId);
    if (!step || !step.suggestedRole) return;
    // Explicit override: caller already pinned an assignee (either via
    // step.assignee or step.suggestedGezelId). Respect it.
    if (step.assignee?.kind === 'gezel' || step.suggestedGezelId) return;
    try {
      const resolved = await this.roleResolver(step.suggestedRole, projectId);
      if (resolved?.gezelId) {
        step.suggestedGezelId = resolved.gezelId;
        log.info(
          `[tasks] resolved step "${step.id}" suggestedRole="${step.suggestedRole}" → gezel ${resolved.gezelId}`,
        );
      }
    } catch (err) {
      log.warn(
        `[tasks] role resolution failed for step "${step.id}" role="${step.suggestedRole}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────

  /**
   * `CreateTaskRequest` requires `description` (≥40 chars) at the MCP /
   * HTTP boundary — callers from Zod-parsed bodies always supply it.
   * We loosen the internal signature so service-level tests that
   * exercise task mechanics without caring about the description
   * requirement don't have to thread boilerplate through every scenario.
   */
  async create(
    projectId: string,
    input: Omit<CreateTaskRequest, 'description'> & { description?: string },
    extras?: {
      /**
       * Service-only provenance stamp (see `Task.origin`). Not part of
       * `CreateTaskRequest` on purpose — HTTP/MCP callers cannot forge it.
       */
      origin?: Task['origin'];
    },
  ): Promise<Task> {
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error(`project ${projectId} not found`);
    const num = await this.store.nextProjectTaskNum(projectId);
    const now = nowIso();
    // A draft is created inert — no entry-step activation, no role
    // resolution, no fanout, no handoff — until `activate()` runs it.
    const isDraft = input.status === 'draft';

    // ── resolve main craftbook ──────────────────────────────────────
    let mainBook: Craftbook;
    const sources: TaskCraftbookSource[] = [];
    if (input.craftbookId) {
      if (!this.craftbookResolver) {
        throw new Error(
          `task ${projectId}/${num}: craftbookId provided but no CraftbookResolver wired`,
        );
      }
      const resolved = await this.craftbookResolver.resolve(input.craftbookId, {
        ...(input.craftbookVersion ? { version: input.craftbookVersion } : {}),
        ...(input.craftbookSourceId ? { sourceId: input.craftbookSourceId } : {}),
        projectId,
      });
      if (!resolved) {
        throw new Error(`task ${projectId}/${num}: craftbook "${input.craftbookId}" not found`);
      }
      mainBook = resolved.craftbook;
      const missingToolsets = unmetToolsets(
        mainBook.toolsets,
        await installedToolsetIds(this.store, projectId),
      );
      if (missingToolsets.length > 0) {
        throw new CraftbookSetupRequiredError(input.craftbookId, missingToolsets);
      }
      sources.push({
        role: 'main',
        catalogId: input.craftbookId,
        ...(resolved.version ? { version: resolved.version } : {}),
        sourceId: resolved.sourceId,
      });
    } else if (input.steps && input.steps.length > 0) {
      mainBook = inlineStepsToCraftbook(input.steps, {
        name: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.plan ? { plan: input.plan } : {}),
        defaultAssignee: input.assignee,
        ...(input.entryStepId ? { entryStepId: input.entryStepId } : {}),
      });
    } else {
      throw new Error(
        `task ${projectId}/${num}: exactly one of craftbookId or steps must be provided`,
      );
    }

    // ── resolve spawn-side craftbook (optional) ─────────────────────
    let spawnBook: Craftbook | undefined;
    if (input.spawnsCraftbookId) {
      if (!this.craftbookResolver) {
        throw new Error(
          `task ${projectId}/${num}: spawnsCraftbookId provided but no CraftbookResolver wired`,
        );
      }
      const resolved = await this.craftbookResolver.resolve(input.spawnsCraftbookId, {
        ...(input.spawnsCraftbookVersion ? { version: input.spawnsCraftbookVersion } : {}),
        ...(input.spawnsCraftbookSourceId ? { sourceId: input.spawnsCraftbookSourceId } : {}),
        projectId,
      });
      if (!resolved) {
        throw new Error(
          `task ${projectId}/${num}: spawn craftbook "${input.spawnsCraftbookId}" not found`,
        );
      }
      spawnBook = resolved.craftbook;
      const missingToolsets = unmetToolsets(
        spawnBook.toolsets,
        await installedToolsetIds(this.store, projectId),
      );
      if (missingToolsets.length > 0) {
        throw new CraftbookSetupRequiredError(input.spawnsCraftbookId, missingToolsets);
      }
      sources.push({
        role: 'spawn',
        catalogId: input.spawnsCraftbookId,
        ...(resolved.version ? { version: resolved.version } : {}),
        sourceId: resolved.sourceId,
      });
    } else if (input.spawnsSteps && input.spawnsSteps.length > 0) {
      spawnBook = inlineStepsToCraftbook(input.spawnsSteps, {
        name: `${input.title} — spawn template`,
        defaultAssignee: input.assignee,
        ...(input.spawnsEntryStepId ? { entryStepId: input.spawnsEntryStepId } : {}),
      });
    } else if (mainBook.spawn) {
      // Declarative fanout: the main craftbook carries a `spawn` block, so
      // this task is a spawn host by construction — derive its spawn
      // template from `mainBook.spawn` REGARDLESS of the create path. Doing
      // it here (not only in the terminal `craftbookInvoker`) means the
      // HTTP create route, the MCP `invoke_craftbook` tool, and the eval
      // harness all produce a working spawn host — the `spawnFanout` step's
      // runtime fanout needs `task.spawnsCraftbook` present to fire.
      spawnBook = inlineStepsToCraftbook(mainBook.spawn.steps, {
        name: `${mainBook.name} — spawn template`,
        defaultAssignee: input.assignee,
        ...(mainBook.spawn.entryStepId ? { entryStepId: mainBook.spawn.entryStepId } : {}),
      });
    }

    let cron: Task['cron'];
    if (input.cron?.expression) {
      const schedule = parseCron(input.cron.expression);
      cron = {
        expression: input.cron.expression,
        nextTickAt: nextCronFire(schedule, new Date()).toISOString(),
        ...(input.cron.overlap ? { overlap: input.cron.overlap } : {}),
      };
    }

    if (input.fanout && !spawnBook) {
      throw new Error('fanout requires a spawn craftbook (spawnsCraftbookId or spawnsSteps)');
    }
    const fanout = input.fanout
      ? ({
          count: input.fanout.count,
          ...(input.fanout.variations ? { variations: input.fanout.variations } : {}),
        } satisfies TaskFanout)
      : undefined;

    const nightShift = input.nightShift?.enabled
      ? {
          enabled: true,
          ...(input.nightShift.onceADay ? { onceADay: true } : {}),
        }
      : undefined;

    const craftbook = snapshotCraftbookForTask(mainBook, now);
    // Land invocation params in the recipe itself, exactly like fanout
    // children do with their per-item context: `{{reviewId}}` in step
    // prompts and gate/advanceWhen file paths becomes concrete BEFORE
    // the snapshot is written, so gates and observable-progress see the
    // resolved paths. Unknown placeholders survive untouched; books
    // without `{{}}` are unaffected.
    const effectiveCraftbookParams = {
      ...craftbookParamDefaults(mainBook.paramSchema),
      ...(input.craftbookParams ?? {}),
    };
    // Connector prep runs BEFORE interpolation, which is the whole reason
    // it lives at launch rather than at step activation: the corpus paths
    // it resolves (`{{corpusScope}}`, a selected PR number) have to be
    // concrete before they are baked into step prompts and gate paths,
    // and interpolation happens exactly once, here.
    let connectorPrepNote: string | undefined;
    if (!isDraft && mainBook.connectors && mainBook.connectors.length > 0) {
      const bound = new Set(
        ((await this.store.getProject(projectId).catch(() => null))?.connectors ?? [])
          .filter((b) => !b.disabled)
          .map((b) => b.type),
      );
      // Some native connectors need no new account/configuration and can be
      // provisioned by launch prep itself. GitHub Pulls is the motivating
      // case: the project is already GitHub-linked and the adapter reuses
      // that credential chain, so a setup dialog would add ceremony without
      // adding authority.
      for (const typeId of this.autoPreparedConnectorTypes) bound.add(typeId);
      const missing = unmetConnectors(mainBook.connectors, bound);
      if (missing.length > 0) {
        throw new ConnectorSetupRequiredError(input.craftbookId ?? mainBook.id, missing);
      }
      if (this.onConnectorPrep) {
        // A prep failure (auth, rate limit, posture) fails the launch —
        // better than creating a task whose first step reads an empty
        // corpus and reports the source as having nothing in it.
        const prep = await this.onConnectorPrep({
          projectId,
          craftbookId: input.craftbookId ?? mainBook.id,
          connectors: mainBook.connectors,
          params: effectiveCraftbookParams,
        });
        Object.assign(effectiveCraftbookParams, prep.params ?? {});
        connectorPrepNote = prep.note;
      }
    }
    if (Object.keys(effectiveCraftbookParams).length > 0) {
      interpolateStepsContext(craftbook.steps, effectiveCraftbookParams);
    }
    // A previous run may have left the same deliverable path behind. An
    // existence-only observable gate would then advance this brand-new task
    // before its assignee changed anything. Preserve explicit author intent
    // (`requireChange: true` or `false`), but make the safe behavior the
    // default whenever the snapshotted path already exists at create time.
    await Promise.all(
      craftbook.steps.map(async (step) => {
        const advanceWhen = step.advanceWhen;
        if (!advanceWhen || advanceWhen.requireChange !== undefined) return;
        const existing = await (advanceWhen.artifact
          ? this.store.readProjectArtifact(projectId, advanceWhen.file)
          : this.store.readProjectWorkspaceFile(projectId, advanceWhen.file)
        ).catch(() => null);
        if (existing !== null) {
          step.advanceWhen = { ...advanceWhen, requireChange: true };
        }
      }),
    );
    const spawnsCraftbook = spawnBook ? snapshotCraftbookForTask(spawnBook, now) : undefined;
    const activeStepId = craftbook.entryStepId;
    if (!isDraft) {
      // First activation of the entry step → attemptCount 1.
      craftbook.steps = bumpStepActivation(craftbook.steps, activeStepId, now);

      // Resolve the entry step's `suggestedRole` (if any) into a concrete
      // gezel id BEFORE writing the task. Without this the very first
      // turn lands on whoever the task assignee is, which often doesn't
      // match the step's intended role (a Developer assigned to a
      // /review craftbook). See `RoleResolver` docs. A draft defers both
      // to `activate()`, so it sits truly inert until the user runs it.
      await this.maybeResolveStepRole(craftbook, activeStepId, projectId);
    }

    // No assignee named: mirror the entry step's binding, so the owner is
    // the gezel actually holding step 1 rather than an arbitrary roster
    // pick that every role-annotated step would override anyway. Only the
    // ENTRY step feeds this — re-pointing the owner at each step's
    // specialist as the task advances would churn the owner column for no
    // one's benefit. A draft resolved nothing above; `activate()` restamps.
    const assigneeAuto = input.assignee === undefined;
    const assignee: TaskAssignee = input.assignee ??
      stepOwnAssignee(craftbook, activeStepId) ?? { kind: 'user' };

    const task: Task = {
      projectId,
      num,
      ref: buildTaskRef(projectId, num),
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.plan ? { plan: input.plan } : {}),
      ...(input.outcomes && input.outcomes.length > 0 ? { outcomes: input.outcomes } : {}),
      status: isDraft ? 'draft' : 'active',
      assignee,
      ...(assigneeAuto ? { assigneeAuto: true } : {}),
      craftbook,
      ...(spawnsCraftbook ? { spawnsCraftbook } : {}),
      ...(sources.length > 0 ? { sourceCraftbookIds: sources } : {}),
      ...(Object.keys(effectiveCraftbookParams).length > 0
        ? { craftbookParams: effectiveCraftbookParams }
        : {}),
      ...(input.spawnsCraftbookParams && Object.keys(input.spawnsCraftbookParams).length > 0
        ? { spawnsCraftbookParams: input.spawnsCraftbookParams }
        : {}),
      activeStepId,
      ...(input.parentTaskRef ? { parentTaskRef: input.parentTaskRef } : {}),
      ...(extras?.origin ? { origin: extras.origin } : {}),
      ...(cron ? { cron } : {}),
      ...(nightShift ? { nightShift } : {}),
      ...(fanout ? { fanout } : {}),
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy ?? { kind: 'user' },
    };

    await this.store.writeTask(task);
    // New work on the project — wake it if it had gone stable.
    await this.reactivateProject(projectId);

    await this.history?.log({
      kind: 'task.created',
      projectId,
      ...(task.assignee.kind === 'gezel' ? { gezelId: task.assignee.gezelId } : {}),
      summary: `Created task ${task.ref} — "${task.title}"`,
      details: {
        ref: task.ref,
        title: task.title,
        status: task.status,
        steps: craftbook.steps.map((s) => ({ id: s.id, name: s.name })),
        assignee: task.assignee,
        ...(spawnsCraftbook ? { spawnSteps: spawnsCraftbook.steps.length } : {}),
        ...(fanout ? { fanout: { count: fanout.count } } : {}),
        ...(sources.length > 0 ? { sourceCraftbookIds: sources } : {}),
      },
    });

    // Roster: assigning a gezel to a task pulls them onto the project.
    if (task.assignee.kind === 'gezel') {
      await this.store.addGezelToProject(projectId, task.assignee.gezelId, { source: 'task' });
    }

    // Record what the connector actually pulled down, so the first step's
    // assignee (and anyone auditing later) can see the corpus it is
    // reading and when it was fetched.
    if (connectorPrepNote) {
      await this.appendNote(projectId, num, {
        text: connectorPrepNote,
        author: { kind: 'user' },
        stepId: activeStepId,
      }).catch(() => {});
    }

    if (this.onTaskCreated) {
      try {
        await this.onTaskCreated({ projectId, task, sources });
      } catch (err) {
        log.error('[tasks] onTaskCreated hook failed:', err);
      }
    }

    if (!isDraft && fanout && spawnsCraftbook) {
      const materialized = await this.materializeFanout(projectId, num);
      return materialized.parent;
    }

    // Entry steps never reach the activation hook (kickoff runs through
    // `dispatchTaskEntry`), so the unsatisfiable check has to happen here
    // too. Returning the paused task is what stops the dispatch: it
    // guards on `status === 'active'`.
    if (!isDraft && !fanout) {
      const entryStep = craftbook.steps.find((s) => s.id === activeStepId);
      if (entryStep && (await this.pauseIfStepUnsatisfiable(projectId, task, entryStep))) {
        return { ...task, status: 'paused' };
      }
    }
    return task;
  }

  async get(projectId: string, num: number): Promise<Task | null> {
    return this.store.readTask(projectId, num);
  }

  async getByRef(ref: string): Promise<Task | null> {
    const parsed = parseTaskRef(ref);
    if (!parsed) return null;
    return this.get(parsed.projectId, parsed.num);
  }

  async list(
    filter: {
      projectId?: string;
      status?: TaskStatus;
      assigneeGezelId?: string;
    } = {},
  ): Promise<Task[]> {
    const tasks = filter.projectId
      ? await this.store.listProjectTasks(filter.projectId)
      : await this.store.listAllTasks();
    return tasks.filter((t) => {
      if (filter.status && t.status !== filter.status) return false;
      if (filter.assigneeGezelId) {
        if (
          t.origin?.kind === 'system-job' &&
          t.origin.managedByGezelId === filter.assigneeGezelId
        ) {
          return true;
        }
        if (t.assignee.kind !== 'gezel') return false;
        if (t.assignee.gezelId !== filter.assigneeGezelId) return false;
      }
      return true;
    });
  }

  async update(projectId: string, num: number, patch: UpdateTaskRequest): Promise<Task> {
    const task = await this.requireTask(projectId, num);
    if (task.origin?.kind === 'system-job' && patch.assignee !== undefined) {
      throw new Error(
        `task ${task.ref}: system jobs are managed by their designated gezel and cannot be reassigned`,
      );
    }
    const changed: string[] = [];
    const next: Task = { ...task, updatedAt: nowIso() };
    if (patch.title !== undefined && patch.title !== task.title) {
      next.title = patch.title;
      changed.push('title');
    }
    if (patch.description !== undefined && patch.description !== task.description) {
      const trimmed = patch.description.trim();
      if (trimmed.length === 0) delete next.description;
      else next.description = patch.description;
      changed.push('description');
    }
    if (patch.plan !== undefined && patch.plan !== task.plan) {
      if (patch.plan === '') delete next.plan;
      else next.plan = patch.plan;
      changed.push('plan');
    }
    if (patch.outcomes !== undefined) {
      if (patch.outcomes === null || patch.outcomes.length === 0) {
        delete next.outcomes;
      } else {
        next.outcomes = patch.outcomes;
      }
      changed.push('outcomes');
    }
    if (patch.assignee !== undefined) {
      next.assignee = patch.assignee;
      // Pinned by hand — stop mirroring the entry step.
      delete next.assigneeAuto;
      changed.push('assignee');
    }
    if (patch.cron !== undefined) {
      if (patch.cron === null) {
        delete next.cron;
      } else {
        const schedule = parseCron(patch.cron.expression);
        next.cron = {
          expression: patch.cron.expression,
          ...(task.cron?.lastTickAt ? { lastTickAt: task.cron.lastTickAt } : {}),
          nextTickAt: nextCronFire(schedule, new Date()).toISOString(),
          ...(patch.cron.overlap
            ? { overlap: patch.cron.overlap }
            : task.cron?.overlap
              ? { overlap: task.cron.overlap }
              : {}),
        };
      }
      changed.push('cron');
    }
    if (patch.nightShift !== undefined) {
      if (patch.nightShift === null || !patch.nightShift.enabled) {
        delete next.nightShift;
      } else {
        next.nightShift = {
          enabled: true,
          ...(patch.nightShift.onceADay ? { onceADay: true } : {}),
          // Preserve the run guard across edits so re-flagging mid-day
          // doesn't grant a fresh run.
          ...(task.nightShift?.lastRunDay ? { lastRunDay: task.nightShift.lastRunDay } : {}),
        };
      }
      changed.push('nightShift');
    }
    if (patch.fanout !== undefined) {
      if (patch.fanout === null) {
        delete next.fanout;
      } else if (task.fanout?.materializedAt) {
        throw new Error(
          `task ${task.ref}: fanout has already materialized (${task.fanout.materializedAt})`,
        );
      } else {
        next.fanout = {
          count: patch.fanout.count,
          ...(patch.fanout.variations ? { variations: patch.fanout.variations } : {}),
        };
      }
      changed.push('fanout');
    }
    if (patch.spawnsCraftbookParams !== undefined) {
      if (patch.spawnsCraftbookParams === null) {
        delete next.spawnsCraftbookParams;
      } else {
        next.spawnsCraftbookParams = patch.spawnsCraftbookParams;
      }
      changed.push('spawnsCraftbookParams');
    }
    if (changed.length === 0) return task;
    await this.store.writeTask(next);
    // Editing a task (retitle, re-plan, reassign, cron/fanout) is live
    // work that isn't closing/completing — wake a stable project.
    await this.reactivateProject(projectId);

    if (changed.includes('assignee')) {
      await this.history?.log({
        kind: 'task.assignee.changed',
        projectId,
        ...(next.assignee.kind === 'gezel' ? { gezelId: next.assignee.gezelId } : {}),
        summary: `Reassigned task ${next.ref}`,
        details: { ref: next.ref, assignee: next.assignee, previous: task.assignee },
      });
      if (next.assignee.kind === 'gezel') {
        await this.store.addGezelToProject(projectId, next.assignee.gezelId, { source: 'task' });
      }
    }
    const otherChanged = changed.filter((c) => c !== 'assignee');
    if (changed.includes('description')) {
      await this.history?.log({
        kind: 'task.about.updated',
        projectId,
        ...(next.assignee.kind === 'gezel' ? { gezelId: next.assignee.gezelId } : {}),
        summary: `Updated description on task ${next.ref}`,
        details: {
          ref: next.ref,
          length: (next.description ?? '').length,
        },
      });
    }
    const remainingChanged = otherChanged.filter((c) => c !== 'description');
    if (remainingChanged.length > 0) {
      await this.history?.log({
        kind: 'task.updated',
        projectId,
        summary: `Updated task ${next.ref} (${remainingChanged.join(', ')})`,
        details: { ref: next.ref, changed: remainingChanged, patch },
      });
    }
    return next;
  }

  // ── Workflow ────────────────────────────────────────────────────

  async setStatus(projectId: string, num: number, status: TaskStatus): Promise<Task> {
    const task = await this.requireTask(projectId, num);
    if (task.origin?.kind === 'system-job' && status !== 'active' && status !== 'paused') {
      throw new Error(`task ${task.ref}: system jobs can only be active or paused`);
    }
    // A draft is an authoring state, not a workflow transition: it is
    // either ACTIVATED (use `activate`, which kicks off the entry step) or
    // CANCELED. Nothing else may leave draft, and nothing may move back to it.
    if (task.status === 'draft' && status !== 'draft' && status !== 'canceled') {
      throw new Error(
        `task ${task.ref}: a draft must be activated (use activate), not set to ${status}`,
      );
    }
    if (status === 'draft' && task.status !== 'draft') {
      throw new Error(`task ${task.ref}: cannot move a ${task.status} task back to draft`);
    }
    if (task.status === status) {
      // No transition, but a re-close is still a stabilization
      // opportunity: a project can be stuck `active` with all-terminal
      // tasks (the original close raced, or predates the stable
      // lifecycle), and the unconditional early-return here meant a
      // voorman re-closing the task could never bring it to rest — the
      // meester kept nudging a finished project (wild-caught,
      // qwen3.6 "Space Shooter Arcade").
      if (status === 'complete' || status === 'canceled') {
        await this.maybeStabilizeProject(projectId);
      }
      return task;
    }
    const now = nowIso();
    let craftbook = task.craftbook;
    // Legacy task snapshots predate the create-time stale-deliverable guard.
    // On resume, protect the active step if its existence-only deliverable is
    // already present; otherwise the first post-resume turn can advance on
    // yesterday's unchanged file. Explicit `requireChange: false` remains an
    // author-controlled opt-out.
    if (task.status === 'paused' && status === 'active' && task.activeStepId) {
      const activeIndex = task.craftbook.steps.findIndex((step) => step.id === task.activeStepId);
      const activeStep = activeIndex >= 0 ? task.craftbook.steps[activeIndex] : undefined;
      const advanceWhen = activeStep?.advanceWhen;
      if (advanceWhen && advanceWhen.requireChange === undefined) {
        const existing = await (advanceWhen.artifact
          ? this.store.readProjectArtifact(projectId, advanceWhen.file)
          : this.store.readProjectWorkspaceFile(projectId, advanceWhen.file)
        ).catch(() => null);
        if (existing !== null) {
          const steps = [...task.craftbook.steps];
          steps[activeIndex] = {
            ...activeStep,
            advanceWhen: { ...advanceWhen, requireChange: true },
          };
          craftbook = { ...task.craftbook, steps, updatedAt: now };
        }
      }
    }
    const next: Task = { ...task, status, craftbook, updatedAt: now };
    await this.store.writeTask(next);
    // Drive the project lifecycle: closing/completing may bring the
    // project to rest; reopening/pausing is live work that wakes it.
    if (status === 'complete' || status === 'canceled') {
      await this.maybeStabilizeProject(projectId);
    } else {
      await this.reactivateProject(projectId);
    }
    await this.history?.log({
      kind: status === 'canceled' ? 'task.canceled' : 'task.status.changed',
      projectId,
      ...(task.assignee.kind === 'gezel' ? { gezelId: task.assignee.gezelId } : {}),
      summary: `Task ${next.ref} → ${status}`,
      details: { ref: next.ref, status, previous: task.status },
    });
    if (status === 'complete' || status === 'canceled') {
      await this.notifyTaskSettled(next, status);
    }
    return next;
  }

  /**
   * Activate a draft task: flip it to `active` and kick off its entry step
   * exactly as a freshly-created live task would — bump the entry step,
   * resolve its role, wake the project, and fire the auto-handoff hook.
   *
   * Refuses a non-draft task, and (unless `force`) a structurally-incomplete
   * plan — the same readiness warnings the UI surfaces — so a half-authored
   * plan can't silently start running. Tasks whose main craftbook came from
   * the catalog are exempt from the readiness check: the guardrails exist
   * for hand-authored plan drafts, and a curated book (steps, gates, and
   * verification authored in the template) would trip the "thin about /
   * few outcomes" heuristics on every launch.
   */
  async activate(projectId: string, num: number, opts: { force?: boolean } = {}): Promise<Task> {
    const task = await this.requireTask(projectId, num);
    if (task.status !== 'draft') {
      throw new Error(`task ${task.ref}: only a draft can be activated (status is ${task.status})`);
    }
    const curatedBook = task.sourceCraftbookIds?.some((s) => s.role === 'main') ?? false;
    if (!opts.force && !curatedBook) {
      const problems = planGuardrails(summarizePlanDocument(task));
      if (problems.length > 0) {
        throw new Error(
          `task ${task.ref} is not ready to activate: ${problems.join('; ')}. Fix these or activate with force.`,
        );
      }
    }
    const now = nowIso();
    const entry = task.craftbook.entryStepId;
    const craftbook: TaskCraftbook = {
      ...task.craftbook,
      steps: bumpStepActivation(task.craftbook.steps, entry, now),
      updatedAt: now,
    };
    const next: Task = {
      ...task,
      status: 'active',
      craftbook,
      activeStepId: entry,
      updatedAt: now,
    };
    await this.maybeResolveStepRole(next.craftbook, entry, projectId);
    // A draft created without a named owner has been carrying an interim
    // `{kind:'user'}` assignee — the entry step's role only just resolved,
    // so this is the first point a real specialist exists to point at.
    if (next.assigneeAuto) {
      const derived = stepOwnAssignee(next.craftbook, entry);
      if (derived) next.assignee = derived;
    }
    await this.store.writeTask(next);
    await this.reactivateProject(projectId);
    await this.history?.log({
      kind: 'task.activated',
      projectId,
      ...(next.assignee.kind === 'gezel' ? { gezelId: next.assignee.gezelId } : {}),
      summary: `Activated draft task ${next.ref} — "${next.title}"`,
      details: { ref: next.ref, entryStepId: entry },
    });
    const entryStep = next.craftbook.steps.find((s) => s.id === entry);
    if (entryStep && this.onStepActivated) {
      try {
        await this.onStepActivated({
          projectId,
          task: next,
          newStep: entryStep,
          completedStep: entryStep,
        });
      } catch (err) {
        log.error('[tasks] onStepActivated hook failed on activate:', err);
      }
    }
    return next;
  }

  async setAssignee(projectId: string, num: number, assignee: TaskAssignee): Promise<Task> {
    return this.update(projectId, num, { assignee });
  }

  async addStep(
    projectId: string,
    num: number,
    input: NewCraftbookStep,
    pos?: StepPosition,
  ): Promise<Task> {
    const task = await this.requireTask(projectId, num);
    // Map the full blueprint surface (incl. suggestedRole/advanceWhen/gate)
    // via the shared resolver, then mint a unique id against this task.
    // Deliverable expansion happens AFTER the mint — the expanded gate
    // loops back with `onReject: <id>`, so it must see the final id.
    const base = resolveSteps([input])[0]!;
    const id = uniqueStepId(task.craftbook.steps, base.name, base.id);
    const expanded = input.deliverable
      ? expandStepDeliverable({ ...base, id }, input.deliverable)
      : { ...base, id };
    const newStep: TaskCraftbookStep = { ...expanded, createdAt: nowIso() };
    const steps = [...task.craftbook.steps];
    steps.splice(stepInsertionIndex(steps, pos), 0, newStep);
    assertCraftbookGraph({ steps, entryStepId: task.craftbook.entryStepId });
    const next: Task = {
      ...task,
      craftbook: { ...task.craftbook, steps, updatedAt: nowIso() },
      // If the parent had no active step yet, the first added step becomes
      // active so the task has something to track.
      ...(task.activeStepId ? {} : { activeStepId: id }),
      updatedAt: nowIso(),
    };
    await this.store.writeTask(next);
    // Adding a step is live work — wake a stable project.
    await this.reactivateProject(projectId);
    await this.history?.log({
      kind: 'task.step.added',
      projectId,
      summary: `Added step "${newStep.name}" to ${next.ref}`,
      details: { ref: next.ref, stepId: newStep.id, name: newStep.name },
    });
    return next;
  }

  /**
   * Patch a single step's mutable fields (`description`, `prompt`,
   * `consumes`, `assignee`, `suggestedGezelId`). `undefined` means "leave alone";
   * explicit `null` on the optional fields means "clear it." Returns
   * the updated task. Returns `null` when the step id doesn't exist.
   */
  async updateStep(
    projectId: string,
    num: number,
    stepId: string,
    patch: UpdateTaskStepRequest,
  ): Promise<Task | null> {
    const task = await this.requireTask(projectId, num);
    const idx = task.craftbook.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) return null;
    const current = task.craftbook.steps[idx] as TaskCraftbookStep;
    // Shared field-merge semantics (preserves lifecycle fields via the generic).
    const updated: TaskCraftbookStep = applyStepPatch(current, patch);
    const steps = [...task.craftbook.steps];
    steps[idx] = updated;
    // Edits that touch edges must keep the graph resolvable.
    assertCraftbookGraph({ steps, entryStepId: task.craftbook.entryStepId });
    const next: Task = {
      ...task,
      craftbook: { ...task.craftbook, steps, updatedAt: nowIso() },
      updatedAt: nowIso(),
    };
    await this.store.writeTask(next);
    // Editing a step is live work — wake a stable project.
    await this.reactivateProject(projectId);
    const changedKeys = Object.keys(patch).filter(
      (k) => patch[k as keyof UpdateTaskStepRequest] !== undefined,
    );
    await this.history?.log({
      kind: 'task.step.updated',
      projectId,
      summary: `Updated step "${updated.name}" on ${next.ref} (${changedKeys.join(', ')})`,
      details: { ref: next.ref, stepId, fields: changedKeys },
    });
    return next;
  }

  /**
   * Remove a step from a task's embedded craftbook, cleaning any dangling
   * edges that pointed at it. Repoints `entryStepId`/`activeStepId` when
   * they referenced the removed step. Returns `null` when the step id
   * doesn't exist; throws when it's the last remaining step.
   */
  async removeStep(projectId: string, num: number, stepId: string): Promise<Task | null> {
    const task = await this.requireTask(projectId, num);
    if (!task.craftbook.steps.some((s) => s.id === stepId)) return null;
    const removedName = task.craftbook.steps.find((s) => s.id === stepId)?.name ?? stepId;
    const steps = removeStepAndCleanEdges(task.craftbook.steps, stepId);
    const entryStepId =
      task.craftbook.entryStepId === stepId ? steps[0]!.id : task.craftbook.entryStepId;
    assertCraftbookGraph({ steps, entryStepId });
    const now = nowIso();
    const activeStepId = task.activeStepId === stepId ? entryStepId : task.activeStepId;
    const next: Task = {
      ...task,
      craftbook: { ...task.craftbook, steps, entryStepId, updatedAt: now },
      ...(activeStepId ? { activeStepId } : {}),
      updatedAt: now,
    };
    await this.store.writeTask(next);
    await this.reactivateProject(projectId);
    await this.history?.log({
      kind: 'task.step.removed',
      projectId,
      summary: `Removed step "${removedName}" from ${next.ref}`,
      details: { ref: next.ref, stepId },
    });
    return next;
  }

  /**
   * Reorder a task's embedded craftbook steps. `order` must be a
   * permutation of the existing step ids (throws otherwise). Lifecycle
   * fields and edges are preserved — only the array order changes.
   */
  async reorderSteps(projectId: string, num: number, order: string[]): Promise<Task> {
    const task = await this.requireTask(projectId, num);
    const steps = reorderStepsArray(task.craftbook.steps, order);
    assertCraftbookGraph({ steps, entryStepId: task.craftbook.entryStepId });
    const now = nowIso();
    const next: Task = {
      ...task,
      craftbook: { ...task.craftbook, steps, updatedAt: now },
      updatedAt: now,
    };
    await this.store.writeTask(next);
    await this.reactivateProject(projectId);
    await this.history?.log({
      kind: 'task.craftbook.reordered',
      projectId,
      summary: `Reordered steps on ${next.ref}`,
      details: { ref: next.ref, order },
    });
    return next;
  }

  /**
   * Patch the overall metadata of a task's embedded craftbook —
   * `name`/`description`/`plan`/`defaultAssignee` and the `entryStepId`.
   * `undefined` leaves a field untouched; `null` clears the nullable ones.
   */
  async updateCraftbookMeta(
    projectId: string,
    num: number,
    patch: {
      name?: string;
      description?: string | null;
      plan?: string | null;
      defaultAssignee?: TaskAssignee | null;
      entryStepId?: string;
    },
  ): Promise<Task> {
    const task = await this.requireTask(projectId, num);
    const cb: TaskCraftbook = { ...task.craftbook };
    if (patch.name !== undefined) cb.name = patch.name;
    if (patch.description !== undefined) {
      if (patch.description === null || patch.description === '') delete cb.description;
      else cb.description = patch.description;
    }
    if (patch.plan !== undefined) {
      if (patch.plan === null || patch.plan === '') delete cb.plan;
      else cb.plan = patch.plan;
    }
    if (patch.defaultAssignee !== undefined) {
      if (patch.defaultAssignee === null) delete cb.defaultAssignee;
      else cb.defaultAssignee = patch.defaultAssignee;
    }
    if (patch.entryStepId !== undefined && cb.steps.some((s) => s.id === patch.entryStepId)) {
      cb.entryStepId = patch.entryStepId;
    }
    assertCraftbookGraph(cb);
    const now = nowIso();
    cb.updatedAt = now;
    const next: Task = { ...task, craftbook: cb, updatedAt: now };
    await this.store.writeTask(next);
    await this.reactivateProject(projectId);
    await this.history?.log({
      kind: 'task.craftbook.updated',
      projectId,
      summary: `Updated craftbook metadata on ${next.ref}`,
      details: { ref: next.ref, fields: Object.keys(patch) },
    });
    return next;
  }

  /**
   * Replace a task's embedded craftbook wholesale from a runtime
   * `Craftbook` — the whole-document write path (`craftbook_write` on a
   * task target). Per-step lifecycle fields (`createdAt`, `attemptCount`,
   * gate bookkeeping…) are preserved for steps whose ids survive the
   * rewrite; `activeStepId` is re-pointed to the entry step when its
   * step vanished. The incoming book must already be graph-valid.
   */
  async replaceCraftbook(projectId: string, num: number, book: Craftbook): Promise<Task> {
    const task = await this.requireTask(projectId, num);
    assertCraftbookGraph(book);
    const now = nowIso();
    const prior = new Map(task.craftbook.steps.map((s) => [s.id, s]));
    const steps: TaskCraftbookStep[] = book.steps.map((s) => {
      const existing = prior.get(s.id);
      return {
        ...s,
        createdAt: existing?.createdAt ?? now,
        ...(existing?.completedAt ? { completedAt: existing.completedAt } : {}),
        ...(existing?.attemptCount !== undefined ? { attemptCount: existing.attemptCount } : {}),
        ...(existing?.lastActivatedAt ? { lastActivatedAt: existing.lastActivatedAt } : {}),
        ...(existing?.gateAttempts !== undefined ? { gateAttempts: existing.gateAttempts } : {}),
        ...(existing?.lastGateReject ? { lastGateReject: existing.lastGateReject } : {}),
        ...(existing?.redriveCount !== undefined ? { redriveCount: existing.redriveCount } : {}),
        ...(existing?.lastRedriveAt ? { lastRedriveAt: existing.lastRedriveAt } : {}),
      };
    });
    const craftbook: TaskCraftbook = {
      id: book.id,
      name: book.name,
      ...(book.description ? { description: book.description } : {}),
      ...(book.version ? { version: book.version } : {}),
      ...(book.basedOn ? { basedOn: book.basedOn } : {}),
      ...(book.plan ? { plan: book.plan } : {}),
      ...(book.defaultAssignee ? { defaultAssignee: book.defaultAssignee } : {}),
      steps,
      entryStepId: book.entryStepId,
      ...(book.triggers ? { triggers: book.triggers } : {}),
      ...(book.hooks ? { hooks: book.hooks } : {}),
      ...(book.toolsets ? { toolsets: book.toolsets } : {}),
      ...(book.connectors ? { connectors: book.connectors } : {}),
      ...(book.scripts ? { scripts: book.scripts } : {}),
      createdAt: task.craftbook.createdAt,
      updatedAt: now,
    };
    const activeStepId =
      task.activeStepId && steps.some((s) => s.id === task.activeStepId)
        ? task.activeStepId
        : book.entryStepId;
    const next: Task = { ...task, craftbook, activeStepId, updatedAt: now };
    await this.store.writeTask(next);
    await this.reactivateProject(projectId);
    await this.history?.log({
      kind: 'task.craftbook.updated',
      projectId,
      summary: `Replaced the craftbook on ${next.ref} (${steps.length} steps)`,
      details: { ref: next.ref, stepCount: steps.length },
    });
    return next;
  }

  /**
   * D3 tier-collapse at handoff dispatch: render this task's embedded
   * craftbook for a TINY executor (merge to a ≤3-step gated chain) and
   * persist it. Returns the dispatched step's id mapped through the
   * collapse (its merge anchor), or null when nothing changed —
   * already rendered, kill switch, multi-assignee book, or the pass
   * failed open. Never throws into the dispatch path.
   */
  async collapseCraftbookForTier(
    projectId: string,
    num: number,
    opts: {
      tier: import('@bendyline/gezel').ModelTier;
      dispatchGezelId: string;
      dispatchStepId: string;
    },
  ): Promise<{ stepId: string } | null> {
    if (process.env.GEZEL_DISABLE_TIER_COLLAPSE === '1') return null;
    const task = await this.requireTask(projectId, num);
    if (task.craftbook.renderedForTier) return null;
    // Single-assignee guard: a tiny model relaying a multi-owner crew
    // book is out of scope for v1 — every step must resolve to the
    // dispatched gezel.
    for (const step of task.craftbook.steps) {
      if (stepOwnerGezelId(task, step) !== opts.dispatchGezelId) {
        log.info(
          `[tasks] tier-collapse skipped for ${task.ref}: step "${step.id}" is not owned by the dispatched gezel`,
        );
        return null;
      }
    }
    const result = collapseCraftbookPass(task.craftbook, { tier: opts.tier });
    if (!result.changed) {
      if (result.skippedReason) {
        log.info(`[tasks] tier-collapse skipped for ${task.ref}: ${result.skippedReason}`);
      }
      return null;
    }
    const now = nowIso();
    const fromSteps = task.craftbook.steps.length;
    const craftbook: TaskCraftbook = {
      ...task.craftbook,
      steps: result.steps,
      entryStepId: result.entryStepId,
      renderedForTier: opts.tier,
      updatedAt: now,
    };
    const activeStepId = task.activeStepId
      ? (result.stepIdMap.get(task.activeStepId) ?? result.entryStepId)
      : task.activeStepId;
    const next: Task = { ...task, craftbook, activeStepId, updatedAt: now };
    await this.store.writeTask(next);
    log.info(
      `[tasks] tier-collapse rendered ${task.ref} for ${opts.tier}: ${fromSteps} → ${result.steps.length} steps`,
    );
    await this.history
      ?.log({
        kind: 'task.craftbook.tier-collapsed',
        projectId,
        gezelId: opts.dispatchGezelId,
        summary: `Rendered ${task.ref} craftbook for ${opts.tier} (${fromSteps} → ${result.steps.length} steps)`,
        details: {
          ref: task.ref,
          fromSteps,
          toSteps: result.steps.length,
          tier: opts.tier,
        },
      })
      .catch(() => {});
    return { stepId: result.stepIdMap.get(opts.dispatchStepId) ?? result.entryStepId };
  }

  async activateStep(projectId: string, num: number, stepId: string): Promise<Task> {
    const task = await this.requireTask(projectId, num);
    const step = task.craftbook.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`task ${task.ref}: no step "${stepId}"`);
    if (task.activeStepId === stepId) return task;
    const now = nowIso();
    const next: Task = {
      ...task,
      craftbook: {
        ...task.craftbook,
        steps: bumpStepActivation(task.craftbook.steps, stepId, now),
        updatedAt: now,
      },
      activeStepId: stepId,
      updatedAt: now,
    };
    await this.store.writeTask(next);
    // Re-activating a step is live work — wake a stable project.
    await this.reactivateProject(projectId);
    await this.history?.log({
      kind: 'task.step.activated',
      projectId,
      summary: `Activated step "${step.name}" on ${next.ref}`,
      details: { ref: next.ref, stepId },
    });
    return next;
  }

  /**
   * Legacy completion surface: advances or THROWS {@link GateRejectionError}
   * when a completion gate holds the step. Callers that can render a
   * rejection (MCP tool, HTTP route, chat auto-advance) use
   * {@link completeStepChecked} instead — a caller that doesn't know about
   * gates must never mistake "held" for "advanced".
   */
  async completeStep(
    projectId: string,
    num: number,
    stepId: string,
    next?: string,
    opts?: CompleteStepOpts,
  ): Promise<Task> {
    const outcome = await this.completeStepChecked(projectId, num, stepId, next, opts);
    if (outcome.status === 'held') throw new GateRejectionError(outcome.gate, outcome.task);
    return outcome.task;
  }

  async completeStepChecked(
    projectId: string,
    num: number,
    stepId: string,
    next?: string,
    opts?: CompleteStepOpts,
  ): Promise<CompleteStepOutcome> {
    const key = `${projectId}\u0000${num}\u0000${stepId}`;
    const existing = this.inFlightStepCompletions.get(key);
    if (existing) return existing;

    const pending = this.completeStepInternal(projectId, num, stepId, next, 0, opts ?? {});
    this.inFlightStepCompletions.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlightStepCompletions.get(key) === pending) {
        this.inFlightStepCompletions.delete(key);
      }
    }
  }

  /**
   * Idle-time twin of `ChatManager.maybeAutoAdvanceOnObservableProgress`.
   * That hook only fires when the assignee actually FINISHES a turn — so a
   * step whose deliverable already clears `advanceWhen` but whose assignee
   * went idle without ever calling `advance_task_step` (turn parked on a
   * consultation, crashed before the hook, or simply stopped) sits forever.
   * The scheduler calls this on a stale step to advance it on the strength
   * of the deliverable alone, routing through the same `completeStepChecked`
   * machinery a model-driven advance would. Returns:
   *
   *   - `'advanced'`  — deliverable cleared `advanceWhen` AND the completion
   *      gate approved; the step moved on (the handoff for the next step
   *      already fired via the normal `onStepActivated` path).
   *   - `'held'`      — `advanceWhen` cleared but the completion gate
   *      rejected (a gate attempt was consumed, possibly pausing the task);
   *      the caller must NOT then re-drive — the gap is the deliverable's
   *      quality, not the assignee's silence.
   *   - `'not-ready'` — no qualifying deliverable yet; caller should
   *      re-drive the assignee.
   *
   * `requireChange` steps never auto-advance from idle: their gate needs a
   * write DURING the triggering turn, and there is none from a sweep.
   */
  async tryIdleAutoAdvance(
    projectId: string,
    num: number,
  ): Promise<'advanced' | 'held' | 'held-frozen' | 'not-ready'> {
    const task = await this.store.readTask(projectId, num).catch(() => null);
    if (!task || task.status !== 'active' || !task.activeStepId) return 'not-ready';
    const step = task.craftbook.steps.find((s) => s.id === task.activeStepId);
    const adv = step?.advanceWhen;
    if (!step || step.terminal || !adv || adv.requireChange) return 'not-ready';

    const content = await (adv.artifact
      ? this.store.readProjectArtifact(projectId, adv.file)
      : this.store.readProjectWorkspaceFile(projectId, adv.file)
    ).catch(() => null);
    // `writes: []` — no turn drove this, so the presence/size/sniff floor is
    // all that can be judged (and `requireChange` is excluded above).
    const observed = evaluateDeliverableGate({ content, spec: adv, writes: [] });
    if (!observed.satisfied) return 'not-ready';

    const outcome = await this.completeStepChecked(projectId, num, step.id, adv.goto, {
      // 'sweep', not 'auto': nobody resubmitted anything — the supervisor
      // is re-checking a stale deliverable, so the escalation ladder must
      // not climb on these evaluations.
      cause: 'sweep',
    }).catch((err) => {
      log.error('[tasks] idle auto-advance failed:', err);
      return null;
    });
    if (!outcome) return 'not-ready';
    // Distinguish a fresh rejection (assignee just heard the verdict)
    // from a frozen replay (deliverable byte-identical to the last
    // reject) — the scheduler redrives on the latter instead of waiting
    // forever on a damper that will never move.
    if (outcome.status === 'held') return outcome.gate.cached ? 'held-frozen' : 'held';
    log.info(
      `[tasks] idle auto-advance: ${task.ref} step "${step.id}" deliverable satisfied ` +
        `(${observed.reason}) — advanced without a model turn`,
    );
    return 'advanced';
  }

  /**
   * Record that the supervisor re-poked a silently-stalled active step:
   * bump `redriveCount` and stamp `lastRedriveAt`. Returns the NEW count so
   * the scheduler can decide poke-again vs escalate. A no-op (returns the
   * current count) if the task/step moved on between the sweep's read and
   * this write — the next sweep re-evaluates from fresh state.
   */
  /**
   * Reset a step's recovery counters after an applied Keurmeester
   * intervention, so the revised step gets a real second chance instead
   * of instantly re-tripping the exhaustion triggers. `redriveCount`
   * set explicitly (the scheduler passes maxRedrives-1 — one more
   * re-drive, then pause for real); `clearGateAttempts` wipes the
   * completion-gate attempt count + last rejection. A no-op when the
   * task or step moved on between the trigger's read and this write.
   */
  async resetStepRecoveryBudget(
    projectId: string,
    num: number,
    stepId: string,
    opts: { redriveCount?: number; clearGateAttempts?: boolean },
  ): Promise<void> {
    const task = await this.store.readTask(projectId, num).catch(() => null);
    if (!task) return;
    const at = nowIso();
    let touched = false;
    const steps = task.craftbook.steps.map((s) => {
      if (s.id !== stepId) return s;
      touched = true;
      const next = { ...s };
      if (opts.redriveCount !== undefined) next.redriveCount = opts.redriveCount;
      if (opts.clearGateAttempts) {
        delete next.gateAttempts;
        delete next.lastGateReject;
        // Also drop the plateau trail: a fresh gate budget with a stale
        // trail would recompute stage 3 on the very next rejection and
        // instantly re-pause, defeating the "real second chance" the
        // applied consult earned.
        delete next.gateAttemptHistory;
      }
      return next;
    });
    if (!touched) return;
    await this.store.writeTask({
      ...task,
      craftbook: { ...task.craftbook, steps, updatedAt: at },
      updatedAt: at,
    });
  }

  async recordStepRedrive(projectId: string, num: number, stepId: string): Promise<number> {
    const task = await this.store.readTask(projectId, num).catch(() => null);
    if (!task || task.activeStepId !== stepId) return 0;
    const at = nowIso();
    let count = 0;
    const steps = task.craftbook.steps.map((s) => {
      if (s.id !== stepId) return s;
      count = (s.redriveCount ?? 0) + 1;
      return { ...s, redriveCount: count, lastRedriveAt: at };
    });
    await this.store.writeTask({
      ...task,
      craftbook: { ...task.craftbook, steps, updatedAt: at },
      updatedAt: at,
    });
    return count;
  }

  /**
   * Edge resolution order, in priority:
   *   1. explicit `next` arg ("jump" — user/model agency wins)
   *   2. an approving completion-gate script's `goto`
   *   3. the completion gate's `onApprove`
   *   4. `step.terminal === true` → no further activation; mark complete
   *   5. `step.branches`: evaluate predicates against the LAST onExit
   *      ref's output, first match wins (`goto`) — legacy routing
   *   6. `step.next` → that step
   *   7. fallback: array index +1 (preserves linear behavior)
   *
   * A COMPLETION gate (see schemas/gate.ts) is evaluated before any of
   * this: a reject returns `held` without stamping `completedAt` — the
   * step stays active and the prescriptive message flows back to the
   * caller. `onExit` is the step's `finally`: it runs on every approved
   * completion (including jumps and terminal), never on a reject.
   */
  private async completeStepInternal(
    projectId: string,
    num: number,
    stepId: string,
    nextArg: string | undefined,
    cascadeDepth: number,
    opts: CompleteStepOpts,
  ): Promise<CompleteStepOutcome> {
    const task = await this.requireTask(projectId, num);
    const idx = task.craftbook.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) throw new Error(`task ${task.ref}: no step "${stepId}"`);
    const completedStep = task.craftbook.steps[idx]!;

    // Step completion is an idempotent transition. Local models can emit the
    // same `advance_task_step` call twice while consuming the first call's
    // tool result. Once the first call has moved the task forward, replaying
    // the stale call must not re-run the old gate/onExit hooks or bump the
    // successor's activation timestamp: TaskRunner keys the live successor
    // handoff by that timestamp and would otherwise cancel it as superseded.
    //
    // A real loop-back remains valid. `bumpStepActivation` clears the old
    // `completedAt` and makes the step active again, so it passes this guard.
    if (task.activeStepId !== stepId) {
      if (completedStep.completedAt) {
        log.info(
          `[tasks] duplicate completion ignored for ${task.ref} step "${stepId}" ` +
            `(active step: "${task.activeStepId ?? '(none)'}")`,
        );
        return { status: 'advanced', task };
      }
      throw new Error(
        `task ${task.ref}: step "${stepId}" is not active ` +
          `(active step: "${task.activeStepId ?? '(none)'}")`,
      );
    }

    // ── Completion gate guard ─────────────────────────────────────────
    // Skipped when: no gate / activation-moment gate (the service hook
    // owns that), the user forced completion, or the runtime itself is
    // routing as a CONSEQUENCE of a gate decision (no re-fire).
    let gateOutcome: StepGateOutcome | null = null;
    let gateOnApprove: string | undefined;
    if (completedStep.gate && !opts.force && opts.cause !== 'gate') {
      const gate = normalizeStepGate(completedStep.gate);
      if (gate.at === 'completion') {
        const result = await this.runCompletionGate(
          projectId,
          task,
          completedStep,
          gate,
          opts.cause,
        );
        if (result.kind === 'held') {
          return { status: 'held', task: result.task, gate: result.info };
        }
        gateOutcome = result.outcome;
        gateOnApprove = gate.onApprove;
      }
    }

    const completedAt = nowIso();
    const updatedSteps = task.craftbook.steps.map((s, i) =>
      i === idx ? { ...s, completedAt } : s,
    );

    // ── onExit: the step's `finally` ──────────────────────────────────
    // Runs on every approved completion — jumps and terminal steps
    // included — in declared order. The LAST ref's output feeds the
    // legacy branch predicates below.
    let exitRun: ScriptRun | null = null;
    for (const ref of normalizeScriptRefs(completedStep.onExit)) {
      exitRun = await this.runStepScript(projectId, task, completedStep, 'exit', ref).catch(
        (err) => {
          log.error('[tasks] step onExit script failed:', err);
          return null;
        },
      );
    }

    // Decide next active step.
    let newActive: string | undefined = task.activeStepId;
    let terminating = false;
    const stepExists = (id: string | undefined): id is string =>
      id !== undefined && task.craftbook.steps.some((s) => s.id === id);

    if (nextArg && nextArg !== 'next') {
      const target = task.craftbook.steps.find((s) => s.id === nextArg);
      if (!target) throw new Error(`task ${task.ref}: no step "${nextArg}" to activate`);
      newActive = nextArg;
    } else if (stepExists(gateOutcome?.goto)) {
      newActive = gateOutcome?.goto;
    } else if (stepExists(gateOnApprove)) {
      newActive = gateOnApprove;
    } else if (completedStep.terminal) {
      terminating = true;
      newActive = undefined;
    } else {
      const branchTarget = completedStep.branches
        ? findBranchGoto(completedStep.branches, exitRun?.output)
        : undefined;
      if (branchTarget) {
        newActive = branchTarget;
      } else if (completedStep.next) {
        newActive = completedStep.next;
      } else {
        const following = task.craftbook.steps[idx + 1];
        if (following) newActive = following.id;
      }
    }

    // Stamp the activation onto the newly-active step so loops expose
    // their re-entry count (build-loop's `evaluate → build`, etc.). Done
    // before `maybeResolveStepRole`, which mutates the same step object
    // in place to add `suggestedGezelId` — both survive.
    const finalSteps =
      newActive && !terminating
        ? bumpStepActivation(updatedSteps, newActive, completedAt)
        : updatedSteps;

    // Once-a-day night-shift task finishing a run: stamp the run day (the
    // window-start local date, so a single overnight window counts as one
    // run) so dispatch won't pick it up again until the next day. Stamped
    // on ANY step completion — the bundled oversight task is a single step
    // that loops back to itself, re-arming each day via this guard rather
    // than ever going terminal. Only read config in the rare path needed.
    let nightShiftPatch: Pick<Task, 'nightShift'> | undefined;
    if (task.nightShift?.onceADay) {
      const cfg = await this.store.readConfig().catch(() => ({}) as GezelConfig);
      const window = cfg.nightShift?.window ?? DEFAULT_NIGHT_SHIFT_WINDOW;
      nightShiftPatch = {
        nightShift: { ...task.nightShift, lastRunDay: nightShiftDayKey(new Date(), window) },
      };
    }

    // Handoff payload from an approving gate script: persisted on the
    // task (the handoff seed prompt injects it) and noted on the next
    // step below (durable, readable via read_task_notes).
    const handoff = gateOutcome?.handoff;
    const updated: Task = {
      ...task,
      craftbook: { ...task.craftbook, steps: finalSteps, updatedAt: nowIso() },
      ...(newActive ? { activeStepId: newActive } : {}),
      ...(terminating ? { status: 'complete' as TaskStatus } : {}),
      ...(nightShiftPatch ?? {}),
      ...(handoff
        ? {
            lastGateHandoff: {
              fromStepId: stepId,
              ...(newActive ? { toStepId: newActive } : {}),
              message: handoff.message,
              ...(handoff.params ? { params: handoff.params } : {}),
              at: nowIso(),
            },
          }
        : {}),
      updatedAt: nowIso(),
    };
    if (terminating || !newActive) {
      delete (updated as { activeStepId?: string }).activeStepId;
    }
    // Commit the state-machine transition BEFORE recruitment. Role resolution
    // may consult a catalog, touch the roster, or (under custom wiring) block;
    // none of that may leave the completed step looking active to an MCP retry.
    // If the process stops after this write, the durable task is still on the
    // correct next step and the runner's recovery sweep can pick it up.
    await this.store.writeTask(updated);

    // Resolve the newly-activated step's `suggestedRole` for the handoff, then
    // persist that enrichment separately. Production task routing uses a
    // deterministic template/static resolver, but the split also protects the
    // transition from slow or third-party resolver implementations.
    if (newActive && !terminating) {
      await this.maybeResolveStepRole(updated.craftbook, newActive, projectId);
      await this.store.writeTask(updated);
    }
    // Terminal step closed the task → the project may have come to rest;
    // advancing to a new step is live work → keep/make it active.
    if (terminating) {
      await this.maybeStabilizeProject(projectId);
    } else {
      await this.reactivateProject(projectId);
    }
    const completedByGezelId = stepOwnerGezelId(updated, completedStep);
    await this.history?.log({
      kind: 'task.step.completed',
      projectId,
      ...(completedByGezelId ? { gezelId: completedByGezelId } : {}),
      summary: `Completed step "${completedStep.name}" on ${updated.ref}`,
      details: { ref: updated.ref, stepId, nextStepId: newActive ?? null },
    });
    // Close any open Keurmeester intervention case watching this step —
    // an advance after an applied consult is the "unblocked" outcome.
    this.keurmeester?.noteStepAdvanced(updated.ref, stepId);

    // Durable copy of the gate handoff on the receiving step's notes.
    if (handoff && newActive) {
      const paramLines = handoff.params
        ? Object.entries(handoff.params)
            .map(([k, v]) => `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join('\n')
        : '';
      await this.appendNote(projectId, num, {
        text: `# Handoff from gate on "${completedStep.name}"\n\n${handoff.message}${paramLines ? `\n\n${paramLines}` : ''}`,
        author: { kind: 'user' },
        stepId: newActive,
      }).catch(() => {});
    }

    // If we set status to complete because the step was terminal, no
    // further activation work to do. The task lifecycle is over.
    if (terminating) {
      await this.history?.log({
        kind: 'task.status.changed',
        projectId,
        summary: `Task ${updated.ref} → complete`,
        details: { ref: updated.ref, status: 'complete', previous: task.status },
      });
      await this.notifyTaskSettled(updated, 'complete');
      return { status: 'advanced', task: updated };
    }

    if (newActive && newActive !== task.activeStepId) {
      const newStep = finalSteps.find((s) => s.id === newActive);
      await this.history?.log({
        kind: 'task.step.activated',
        projectId,
        summary: `Activated step "${newStep?.name ?? newActive}" on ${updated.ref}`,
        details: { ref: updated.ref, stepId: newActive },
      });

      if (newStep) {
        // Run ALL onEnter refs in order; a ref auto-advances when ITS
        // OWN predicate matches ITS OWN output (predictable — a later
        // setup script is never skipped because an earlier one matched).
        let autoAdvance = false;
        for (const ref of normalizeScriptRefs(newStep.onEnter)) {
          const enterRun = await this.runStepScript(
            projectId,
            updated,
            newStep,
            'enter',
            ref,
          ).catch((err) => {
            log.error('[tasks] step onEnter script failed:', err);
            return null;
          });
          if (enterRun && enterRun.status === 'ok' && shouldAutoAdvance(ref, enterRun.output)) {
            autoAdvance = true;
          }
        }

        if (autoAdvance) {
          if (cascadeDepth + 1 > STEP_CASCADE_CAP) {
            log.warn(
              `[tasks] cascade cap (${STEP_CASCADE_CAP}) hit for ${updated.ref}; pausing task.`,
            );
            await this.setStatus(projectId, num, 'paused');
            return { status: 'advanced', task: { ...updated, status: 'paused' } };
          }
          // A held cascade (the next step's own completion gate
          // rejected) stops the chain; THIS step still advanced — the
          // rejection note is already on the downstream step.
          const cascaded = await this.completeStepInternal(
            projectId,
            num,
            newStep.id,
            undefined,
            cascadeDepth + 1,
            { cause: 'auto' },
          );
          return { status: 'advanced', task: cascaded.task };
        }

        // No auto-advance → fire the handoff hook so a gezel picks up,
        // unless nobody could satisfy the step under current policy.
        if (await this.pauseIfStepUnsatisfiable(projectId, updated, newStep)) {
          return { status: 'advanced', task: { ...updated, status: 'paused' } };
        }
        if (this.onStepActivated) {
          try {
            await this.onStepActivated({
              projectId,
              task: updated,
              newStep,
              completedStep: completedStep as TaskCraftbookStep,
            });
          } catch (err) {
            log.error('[tasks] onStepActivated hook failed:', err);
          }
        }
      }
    }
    return { status: 'advanced', task: updated };
  }

  /**
   * Append one `task.step.gated` history event per REAL gate evaluation
   * (approve or reject; damped byte-identical replays don't emit). The
   * details carry the per-book join key + failing check kinds — the raw
   * material for never-fires/always-holds calibration (aggregated by
   * `aggregateGateStats` in gate-telemetry.ts).
   */
  private async logStepGated(opts: {
    projectId: string;
    task: Task;
    step: TaskCraftbookStep;
    gateAt: 'completion' | 'activation';
    decision: 'approve' | 'reject';
    attempt: number;
    maxAttempts: number;
    paused: boolean;
    outcome?: StepGateOutcome;
    /** Escalation-ladder annotations (damper-escalations carry frozen). */
    extra?: { escalationStage?: EscalationStage; frozen?: boolean };
  }): Promise<void> {
    const {
      projectId,
      task,
      step,
      gateAt,
      decision,
      attempt,
      maxAttempts,
      paused,
      outcome,
      extra,
    } = opts;
    const failedChecks = (outcome?.checkResults ?? []).filter((c) => !c.ok);
    const rejectingScript = outcome?.runs.find((r) => r.decision === 'reject' || r.error);
    const failedKinds: string[] =
      failedChecks.length > 0
        ? failedChecks.map((c) => c.kind)
        : rejectingScript
          ? [`script:${rejectingScript.scriptName}`]
          : [];
    const book = mainBookSource(task);
    const gezelId = stepOwnerGezelId(task, step);
    // Advisory-judge telemetry: the first judge outcome's verdict +
    // surviving quote — the accumulating false-reject dataset for the
    // promote-to-fail-closed decision (task-completion §1.4c).
    const judgeOutcome = (outcome?.checkResults ?? []).find((c) => c.kind === 'judge');
    const judgeEvidence = (
      judgeOutcome?.evidence as
        | { judge?: { verdict?: string; quotes?: string[]; reason?: string } }
        | undefined
    )?.judge;
    const advisoryJudge = judgeEvidence?.verdict
      ? {
          verdict: judgeEvidence.verdict,
          ...(judgeEvidence.quotes?.[0] ? { quote: judgeEvidence.quotes[0].slice(0, 200) } : {}),
        }
      : undefined;
    // Best-effort model stamp: resolve the working session for this
    // (task, step) so gate outcomes become per-model evidence for
    // capability-floor routing (aggregateModelGateEvidence). No
    // matching session (activation-gated fresh steps, auto-advance
    // from plain sessions) → no stamp; the aggregation skips those.
    let workingModel: { model: string; provider: string } | undefined;
    if (gezelId) {
      const sessions = await this.store.listSessions({ gezelId }).catch(() => []);
      const working = sessions
        .filter((s) => s.taskRef === task.ref && s.stepId === step.id)
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
      if (working?.model) {
        workingModel = { model: working.model, provider: working.providerName };
      }
    }
    await this.history
      ?.log({
        kind: 'task.step.gated',
        projectId,
        ...(gezelId ? { gezelId } : {}),
        summary:
          decision === 'approve'
            ? `Gate approved ${task.ref} step "${step.name}"`
            : `Gate rejected ${task.ref} step "${step.name}" (attempt ${attempt}/${maxAttempts})`,
        details: {
          ref: task.ref,
          stepId: step.id,
          decision,
          gateAt,
          attempt,
          maxAttempts,
          paused,
          bookCatalogId: book.catalogId,
          ...(book.version ? { bookVersion: book.version } : {}),
          ...(decision === 'reject' && failedKinds.length > 0
            ? { firstFailKind: failedKinds[0], failedKinds }
            : {}),
          ...(outcome && outcome.skipped.length > 0 ? { skippedScripts: outcome.skipped } : {}),
          ...(outcome?.infrastructureError ? { infrastructureError: true } : {}),
          ...(rejectingScript?.runId ? { scriptRunId: rejectingScript.runId } : {}),
          ...(rejectingScript?.error ? { scriptError: rejectingScript.error } : {}),
          ...(rejectingScript?.logsTail ? { scriptLogsTail: rejectingScript.logsTail } : {}),
          ...(extra?.escalationStage ? { escalationStage: extra.escalationStage } : {}),
          ...(extra?.frozen ? { frozen: true } : {}),
          ...(workingModel ? workingModel : {}),
          ...(advisoryJudge ? { advisoryJudge } : {}),
        },
      })
      .catch(() => {});
  }

  /**
   * Evaluate a step's COMPLETION gate. Approve → return the outcome so
   * routing/handoff use it. Reject → persist `gateAttempts` +
   * `lastGateReject` on the step, append the prescriptive note, pause at
   * maxAttempts, optionally loop back (`goto`/`onReject`) — and report
   * `held`. The step is NOT completed on reject.
   */
  private async runCompletionGate(
    projectId: string,
    task: Task,
    step: TaskCraftbookStep,
    gate: NormalizedStepGate,
    cause?: CompleteStepOpts['cause'],
  ): Promise<
    | { kind: 'approved'; outcome: StepGateOutcome }
    | { kind: 'held'; task: Task; info: GateHoldInfo }
  > {
    const priorAttempts = step.gateAttempts ?? 0;
    // The ladder climbs only on model-driven completion attempts ('model'
    // = advance_task_step / HTTP, 'auto' = the observable-progress
    // auto-advancer reacting to a model's write). Sweep re-checks and
    // user/gate routing must not escalate at nobody.
    const modelDriven =
      !escalationDisabled() && (cause === 'model' || cause === 'auto' || cause === undefined);
    const logGated = (
      decision: 'approve' | 'reject',
      attempt: number,
      paused: boolean,
      outcome?: StepGateOutcome,
      extra?: { escalationStage?: EscalationStage; frozen?: boolean },
    ) =>
      this.logStepGated({
        projectId,
        task,
        step,
        gateAt: 'completion',
        decision,
        attempt,
        maxAttempts: gate.maxAttempts,
        paused,
        ...(outcome ? { outcome } : {}),
        ...(extra ? { extra } : {}),
      });

    // Repeat-reject damping: when the gated deliverable is byte-identical
    // to what this gate last rejected, skip the re-evaluation — zero
    // sandbox spawns, no attempt bump. Legacy behavior returned the cached
    // rejection whose fingerprint the chat layer then deduped into
    // SILENCE — a frozen resubmitter stopped being nudged entirely (the
    // verified gap). Model-driven frozen resubmits now climb
    // the escalation ladder instead: fresh stage directive, fresh
    // fingerprint, so the nudge actually delivers.
    let contentHash: string | undefined;
    if (step.advanceWhen?.file) {
      const content = await (step.advanceWhen.artifact
        ? this.store.readProjectArtifact(projectId, step.advanceWhen.file)
        : this.store.readProjectWorkspaceFile(projectId, step.advanceWhen.file)
      ).catch(() => null);
      if (content !== null) {
        contentHash = createHash('sha256').update(content).digest('hex');
      }
    }
    if (
      contentHash !== undefined &&
      step.lastGateReject?.contentHash !== undefined &&
      step.lastGateReject.contentHash === contentHash
    ) {
      const cachedInfo: GateHoldInfo = {
        message: step.lastGateReject.message,
        messageFingerprint: step.lastGateReject.messageFingerprint,
        attempt: Math.max(priorAttempts, 1),
        maxAttempts: gate.maxAttempts,
        paused: false,
        cached: true,
      };
      if (!modelDriven) {
        return { kind: 'held', task, info: cachedInfo };
      }

      // Escalator: a frozen resubmit extends the trailing plateau run.
      const trail = step.gateAttemptHistory;
      const lastEntry = trail?.at(-1);
      const signature = lastEntry?.signatureHash ?? step.lastGateReject.messageFingerprint;
      const score = plateauScore(trail, signature);
      let stage = stageForPlateau(score);
      const deliverableFile = step.advanceWhen?.file;
      if (stage === 2 && !deliverableFile) stage = 1;
      const frozenEntry: GateAttemptRecord = {
        at: nowIso(),
        attempt: Math.max(priorAttempts, 1),
        contentHash,
        signatureHash: signature,
        messageFingerprint: step.lastGateReject.messageFingerprint,
        ...(lastEntry?.failedChecks ? { failedChecks: lastEntry.failedChecks } : {}),
        frozen: true,
      };
      const newTrail = appendGateAttempt(trail, frozenEntry);
      const persistTrail = async (extraStep: Partial<TaskCraftbookStep> = {}) => {
        const steps = task.craftbook.steps.map((s) =>
          s.id === step.id ? { ...s, gateAttemptHistory: newTrail, ...extraStep } : s,
        );
        const updated: Task = {
          ...task,
          craftbook: { ...task.craftbook, steps, updatedAt: nowIso() },
          updatedAt: nowIso(),
        };
        await this.store.writeTask(updated);
        return updated;
      };

      if (stage === 3) {
        const updated = await persistTrail();
        // Keurmeester escalation: the frozen-resubmit ladder is spent —
        // the model keeps handing back the SAME bytes against the same
        // verdict. Consult before pausing; an applied verdict earns a
        // fresh ladder (budget + trail reset), stand_down/misses pause
        // with the diagnosis exactly as before.
        const plateauAssignee =
          step.assignee?.kind === 'gezel'
            ? step.assignee.gezelId
            : (step.suggestedGezelId ??
              (task.assignee.kind === 'gezel' ? task.assignee.gezelId : undefined));
        if (this.keurmeester && plateauAssignee) {
          const consult = await this.keurmeester
            .consultTaskStall({
              trigger: 'deliverable_plateau',
              triggerSummary: `frozen resubmit plateau: the model resubmitted byte-identical content ${score}× against the same gate verdict; the task is about to pause for help`,
              projectId,
              taskNum: task.num,
              taskRef: task.ref,
              stepId: step.id,
              assigneeGezelId: plateauAssignee,
              gateSummary: `Frozen resubmits: ${score}. Unmoved verdict: ${step.lastGateReject.message}`,
              signals: {
                plateauScore: score,
                frozen: true,
                ...(lastEntry?.failedChecks ? { failedChecks: lastEntry.failedChecks } : {}),
              },
            })
            .catch((err: unknown) => {
              log.warn(
                `[gate] keurmeester plateau consult threw: ${err instanceof Error ? err.message : err}`,
              );
              return null;
            });
          if (consult?.applied && consult.action === 'takeover_step' && consult.takeoverAdvanced) {
            await logGated('reject', cachedInfo.attempt, false, undefined, {
              escalationStage: 3,
              frozen: true,
            });
            return { kind: 'held', task: updated, info: { ...cachedInfo, escalationStage: 3 } };
          }
          if (consult?.applied && consult.action !== 'takeover_step') {
            await this.resetStepRecoveryBudget(projectId, task.num, step.id, {
              clearGateAttempts: true,
            });
            log.info(
              `[gate] ${task.ref} step "${step.id}": keurmeester ${consult.action} applied on frozen plateau — ladder reset, task stays active`,
            );
            await logGated('reject', cachedInfo.attempt, false, undefined, {
              escalationStage: 3,
              frozen: true,
            });
            return { kind: 'held', task: updated, info: { ...cachedInfo, escalationStage: 3 } };
          }
          // Failed takeover or stand_down: fall through to the pause.
        }
        const diagnosis = buildPlateauDiagnosisNote({
          stepName: step.name,
          stepId: step.id,
          trail: newTrail,
          lastMessage: step.lastGateReject.message,
        });
        await this.appendNote(projectId, task.num, {
          text: diagnosis,
          author: { kind: 'user' },
          stepId: step.id,
        }).catch(() => {});
        await this.setStatus(projectId, task.num, 'paused').catch(() => {});
        log.warn(
          `[gate] ${task.ref} step "${step.id}" plateaued (${score} identical rejections, frozen deliverable) — pausing with diagnosis`,
        );
        await logGated('reject', cachedInfo.attempt, true, undefined, {
          escalationStage: 3,
          frozen: true,
        });
        await this.emitNeedsHelp({
          projectId,
          task,
          stepId: step.id,
          reason: 'gate_plateau',
          detail: `${score} byte-identical resubmits against the same gate verdict: ${step.lastGateReject.message.split('\n')[0] ?? ''}`,
        });
        return {
          kind: 'held',
          task: { ...updated, status: 'paused' },
          info: { ...cachedInfo, paused: true, escalationStage: 3 },
        };
      }

      const frozenSurface = step.advanceWhen?.artifact
        ? ('artifact' as const)
        : ('workspace' as const);
      const nudge =
        stage === 2 && deliverableFile
          ? buildStageTwoNudge({
              file: deliverableFile,
              failingBullets: step.lastGateReject.message,
              repeats: score,
              surface: frozenSurface,
            })
          : buildStageOneNudge({
              ...(deliverableFile ? { file: deliverableFile } : {}),
              failingBullets: step.lastGateReject.message,
              frozen: true,
              surface: frozenSurface,
            });
      const updated = await persistTrail();
      log.info(
        `[gate] ${task.ref} step "${step.id}": frozen resubmit ${score}× — escalating to stage ${stage}`,
      );
      await logGated('reject', cachedInfo.attempt, false, undefined, {
        escalationStage: stage,
        frozen: true,
      });
      return {
        kind: 'held',
        task: updated,
        info: {
          ...cachedInfo,
          message: nudge,
          messageFingerprint: gateMessageFingerprint(nudge),
          escalationStage: stage,
        },
      };
    }

    const ws: GateWorkspaceReader = {
      read: (f) => this.store.readProjectWorkspaceFile(projectId, f).catch(() => null),
      list: async () =>
        (await this.store.listProjectWorkspaceRecursive(projectId).catch(() => []))
          .filter((e) => !e.isDirectory)
          .map((e) => e.path),
      // Byte reader for image-signature checks (fileCount.verifyImageBytes).
      readBytes: (f) => this.store.readProjectWorkspaceBinary(projectId, f).catch(() => null),
      readArtifact: (f) => this.store.readProjectArtifact(projectId, f).catch(() => null),
      readArtifactBytes: async (f) =>
        (await this.store.readProjectArtifactBinary(projectId, f).catch(() => null))?.data ?? null,
      listArtifacts: async () =>
        (await this.store.listProjectArtifactsRecursive(projectId).catch(() => []))
          .filter((e) => !e.isDirectory)
          .map((e) => e.path),
    };
    const outcome = await evaluateStepGate({
      gate,
      ws,
      runScript: (ref) => this.runGateScript(projectId, task, step, ref),
      deps: {
        // The nodeRuns executor — same security fence as user scripts:
        // when the policy disables script execution, the check rejects
        // with the policy message (fail-closed) instead of running.
        sandboxExec: async (file, timeoutMs) => {
          const config = await this.store.readConfig();
          if (!resolveSecurityPolicy(config).allowScriptExecution) {
            return {
              exitCode: 1,
              stderrTail:
                'Security policy: script execution is disabled, so this execution gate cannot run. Raise the security level in Settings → Security & Compliance, or replace the nodeRuns check.',
              timedOut: false,
              denied: true,
            };
          }
          return execNodeRunsInSandbox({ read: ws.read, file, timeoutMs });
        },
        judgeExec: async (prompt, timeoutMs) => {
          if (!this.keurmeester) return { unavailable: 'keurmeester not armed' };
          const budgetKey = `${task.ref}:${step.id}`;
          const used = this.judgeCallCounts.get(budgetKey) ?? 0;
          if (used >= 3) {
            return { unavailable: 'per-step judge budget exhausted (3 calls)' };
          }
          this.judgeCallCounts.set(budgetKey, used + 1);
          return this.keurmeester.judgeOneShot(prompt, timeoutMs);
        },
        researchEvidence: async ({ sourcePath, tools }) => {
          if (!this.history) return { observable: false, matches: [] };
          const events = await this.history.listEvents({
            projectId,
            kinds: ['tool.called'],
            ...(step.lastActivatedAt ? { from: step.lastActivatedAt } : {}),
          });
          const allowed = new Set(tools);
          const normalizePath = (value: string | undefined): string =>
            (value ?? '')
              .trim()
              .replace(/\\/g, '/')
              .replace(/^workspace\//i, '')
              .replace(/^\.\//, '')
              .toLocaleLowerCase();
          const expectedPath = normalizePath(sourcePath);
          const matches: Array<{
            tool: string;
            path?: string;
            target?: string;
            at?: string;
          }> = [];
          for (const event of events) {
            const details = event.details as Record<string, unknown> | undefined;
            if (!details || details.success !== true) continue;
            if (details.taskRef !== task.ref || details.stepId !== step.id) continue;
            const tool = typeof details.name === 'string' ? details.name : '';
            const path = typeof details.path === 'string' ? details.path : undefined;
            const paths = Array.isArray(details.paths)
              ? details.paths.filter((value): value is string => typeof value === 'string')
              : [];
            const target =
              typeof details.researchTarget === 'string' ? details.researchTarget : undefined;
            const exactLocalRead =
              expectedPath.length > 0 &&
              ((tool === 'read_file' &&
                path !== undefined &&
                normalizePath(path) === expectedPath) ||
                (tool === 'read_files' &&
                  paths.some((value) => normalizePath(value) === expectedPath)));
            let externalAcquisition = allowed.has(tool) && target !== undefined;
            if (externalAcquisition && tool === 'run_playwright_script') {
              const scriptPath = target?.startsWith('script:')
                ? target.slice('script:'.length)
                : '';
              const script = scriptPath
                ? ((await ws.readArtifact?.(scriptPath)) ?? (await ws.read(scriptPath)))
                : null;
              // A successful Playwright run is source acquisition only when
              // the script itself targets an external URL. Local preview/QA
              // scripts must not satisfy a research gate by accident.
              externalAcquisition = Boolean(script && /https?:\/\//i.test(script));
            }
            if (!exactLocalRead && !externalAcquisition) continue;
            matches.push({
              tool,
              ...(path ? { path } : {}),
              ...(target ? { target } : {}),
              at: event.at,
            });
          }
          return { observable: true, matches };
        },
      },
    });

    if (outcome.infrastructureError) {
      const message = outcome.message ?? 'The completion gate could not run.';
      const scriptRuns = outcome.runs.filter((run) => run.error || run.logsTail);
      const diagnostics = formatGateScriptDiagnostics(scriptRuns);
      const paused = await this.setStatus(projectId, task.num, 'paused').catch(() => ({
        ...task,
        status: 'paused' as const,
      }));
      await this.appendNote(projectId, task.num, {
        text: `# Gate unavailable — task paused\n\n${message}${diagnostics ? `\n\n## Script diagnostics\n\n${diagnostics}` : ''}\n\nThis is a gate/runtime problem, not a failed deliverable check. No completion attempt was consumed. Fix the gate or runtime, then set the task active and retry.`,
        author: { kind: 'user' },
        stepId: step.id,
      }).catch(() => {});
      log.error(
        `[gate] ${task.ref} step "${step.id}" could not be evaluated — pausing without consuming an attempt: ${message}${diagnostics ? ` diagnostics=${JSON.stringify(diagnostics)}` : ''}`,
      );
      await logGated('reject', priorAttempts, true, outcome);
      await this.emitNeedsHelp({
        projectId,
        task,
        stepId: step.id,
        reason: 'gate_infrastructure',
        detail: message.split('\n')[0] ?? message,
      });
      return {
        kind: 'held',
        task: paused,
        info: {
          message,
          messageFingerprint: gateMessageFingerprint(message),
          attempt: priorAttempts,
          maxAttempts: gate.maxAttempts,
          paused: true,
          cached: false,
          infrastructureError: true,
          ...(scriptRuns.length > 0 ? { scriptRuns } : {}),
          ...(outcome.checkResults ? { checkResults: outcome.checkResults } : {}),
        },
      };
    }

    if (outcome.decision === 'approve') {
      this.judgeCallCounts.delete(`${task.ref}:${step.id}`);
      // Advisory judge opinions ride the APPROVE — visible to the user
      // and the next session without holding the step. This is the
      // false-reject dataset for the promote-to-fail-closed decision.
      const advisoryLines = (outcome.checkResults ?? [])
        .filter((c) => {
          const judge = (c.evidence as { judge?: { advisory?: boolean; verdict?: string } })?.judge;
          return judge?.advisory === true && judge.verdict === 'fail';
        })
        .map((c) => `- ${c.detail}`);
      if (advisoryLines.length > 0) {
        await this.appendNote(projectId, task.num, {
          text: `# Advisory judge notes\n\nThe step was approved; a judge check would have flagged:\n\n${advisoryLines.join('\n')}`,
          author: { kind: 'user' },
          stepId: step.id,
        }).catch(() => {});
      }
      if (outcome.skipped.length > 0) {
        await this.appendNote(projectId, task.num, {
          text: `# Gate scripts skipped\n\nScript execution is disabled by the current security/engagement settings, so these gate scripts did not run: ${outcome.skipped.join(', ')}. The step was approved on the remaining checks (fail-open).`,
          author: { kind: 'user' },
          stepId: step.id,
        }).catch(() => {});
      }
      await logGated('approve', priorAttempts, false, outcome);
      return { kind: 'approved', outcome };
    }

    // Satisfiability pre-flight: a rejection no assignee can repair under
    // current policy must not burn the attempt budget or climb the nudge
    // ladder toward tools nobody has. The known case: a workspace-tree
    // check failing while gezel workspace writes are OFF for the project
    // (a workspace-path deliverable gate on a writes-off project). Pause
    // like a gate-infrastructure failure — no attempt consumed, a note
    // naming the real cause and the real fixes — instead of charging the
    // budget and then demanding `write_file` from a roster it was
    // stripped from.
    const unsatFiles = await this.unsatisfiableWorkspaceGateFiles(projectId, gate, outcome);
    if (unsatFiles) {
      const fileList =
        unsatFiles.length > 0 ? unsatFiles.map((f) => `\`${f}\``).join(', ') : 'files';
      const message = `This gate cannot be met right now: it requires workspace ${fileList} to change, but managed workspace writes are OFF for this project. The task is paused for a human decision; do not retry. See the task notes for the fixes.`;
      const paused = await this.setStatus(projectId, task.num, 'paused').catch(() => ({
        ...task,
        status: 'paused' as const,
      }));
      await this.appendNote(projectId, task.num, {
        text: `# Gate unsatisfiable — task paused\n\nStep "${step.name}" (\`${step.id}\`) is gated on workspace ${fileList}, but managed workspace writes are OFF for this project — no managed task assignee can create or edit workspace files, so retrying cannot succeed. No completion attempt was consumed.\n\nFix one of these, then set the task active again:\n\n- Enable "${MANAGED_WORKSPACE_WRITE_SETTING_LABEL}" in Project → Settings.\n- Change the step's deliverable to the artifacts drawer (\`artifact: true\`, written with \`write_artifact\`) — the drawer stays writable when workspace writes are off.\n- Create or fix the file(s) by hand from the content in task notes.`,
        author: { kind: 'user' },
        stepId: step.id,
      }).catch(() => {});
      log.warn(
        `[gate] ${task.ref} step "${step.id}" gate is unsatisfiable (workspace writes off) — pausing without consuming an attempt`,
      );
      await logGated('reject', priorAttempts, true, outcome);
      // Activation already paused and reported an unwinnable step; the
      // caller still gets the verdict below, but one blocked step must
      // not raise a second needs-help.
      if (task.status !== 'paused') {
        await this.emitNeedsHelp({
          projectId,
          task,
          stepId: step.id,
          reason: 'gate_unsatisfiable',
          detail: `The gate requires workspace ${fileList}, but managed workspace writes are off for this project.`,
        });
      }
      return {
        kind: 'held',
        task: paused,
        info: {
          message,
          messageFingerprint: gateMessageFingerprint(message),
          attempt: priorAttempts,
          maxAttempts: gate.maxAttempts,
          paused: true,
          cached: false,
          unsatisfiable: true,
          ...(outcome.checkResults ? { checkResults: outcome.checkResults } : {}),
        },
      };
    }

    const attempt = priorAttempts + 1;
    const rawMessage = outcome.message ?? 'Gate rejected the step.';
    // Plateau scoring: same failing-check identity set as the trailing
    // attempts = no progress. Stage directives replace the raw verdict so
    // the model gets a strategy CHANGE, not the same bullets again.
    const signature = gateFailureSignature(outcome.checkResults, outcome.runs);
    const score = plateauScore(step.gateAttemptHistory, signature);
    let stage: EscalationStage = modelDriven ? stageForPlateau(score) : 0;
    const deliverableFile = step.advanceWhen?.file;
    if (stage === 2 && !deliverableFile) stage = 1;
    const rejectSurface = step.advanceWhen?.artifact
      ? ('artifact' as const)
      : ('workspace' as const);
    const message =
      stage === 1
        ? buildStageOneNudge({
            ...(deliverableFile ? { file: deliverableFile } : {}),
            failingBullets: rawMessage,
            frozen: false,
            surface: rejectSurface,
          })
        : stage === 2 && deliverableFile
          ? buildStageTwoNudge({
              file: deliverableFile,
              failingBullets: rawMessage,
              repeats: score,
              surface: rejectSurface,
            })
          : rawMessage;
    const fingerprint = gateMessageFingerprint(message);
    const now = nowIso();
    const failedLabels = (outcome.checkResults ?? [])
      .filter((c) => !c.ok)
      .map((c) => c.label)
      .slice(0, 8);
    const rejectingScript = outcome.runs.find((r) => r.decision === 'reject' || r.error);
    const trailEntry: GateAttemptRecord = {
      at: now,
      attempt,
      ...(contentHash !== undefined ? { contentHash } : {}),
      signatureHash: signature,
      messageFingerprint: fingerprint,
      ...(failedLabels.length > 0
        ? { failedChecks: failedLabels }
        : rejectingScript
          ? { failedChecks: [`script:${rejectingScript.scriptName}`] }
          : {}),
    };
    const newTrail = appendGateAttempt(step.gateAttemptHistory, trailEntry);
    const steps = task.craftbook.steps.map((s) =>
      s.id === step.id
        ? {
            ...s,
            gateAttempts: attempt,
            gateAttemptHistory: newTrail,
            lastGateReject: {
              ...(contentHash !== undefined ? { contentHash } : {}),
              messageFingerprint: fingerprint,
              message,
              at: now,
            },
          }
        : s,
    );
    let updated: Task = {
      ...task,
      craftbook: { ...task.craftbook, steps, updatedAt: now },
      updatedAt: now,
    };
    await this.store.writeTask(updated);
    await this.appendNote(projectId, task.num, {
      text: `# Gate — not yet met (attempt ${attempt}/${gate.maxAttempts})\n\n${message}\n\nAddress these specifically, then advance again — the gate re-checks automatically.`,
      author: { kind: 'user' },
      stepId: step.id,
    }).catch(() => {});
    if (stage > 0) {
      log.info(
        `[gate] ${task.ref} step "${step.id}": ${score} identical-signature rejections — escalating to stage ${stage}`,
      );
    }

    if (attempt >= gate.maxAttempts || stage === 3) {
      // Keurmeester escalation point: the gate budget is spent and the
      // pause-for-help is imminent. Consult first — an applied verdict
      // (corrective message, step/craftbook rewrite, or takeover) keeps
      // the task active with a fresh gate budget; stand_down, predicate
      // misses, and consult failures pause exactly as before.
      const gateAssignee =
        step.assignee?.kind === 'gezel'
          ? step.assignee.gezelId
          : (step.suggestedGezelId ??
            (task.assignee.kind === 'gezel' ? task.assignee.gezelId : undefined));
      if (this.keurmeester && gateAssignee) {
        // Stage-3 before the attempt budget is spent = a busy plateau
        // (same failing checks, content churning) — a distinct trigger
        // kind so case records separate it from plain budget exhaustion.
        const plateaued = stage === 3 && attempt < gate.maxAttempts;
        const consult = await this.keurmeester
          .consultTaskStall({
            trigger: plateaued ? 'deliverable_plateau' : 'gate_exhausted',
            triggerSummary: plateaued
              ? `gate plateau: ${score} rejections with the identical failing-check signature; the task is about to pause for help`
              : `completion gate rejected the deliverable ${attempt}/${gate.maxAttempts} times; the task is about to pause for help`,
            projectId,
            taskNum: task.num,
            taskRef: task.ref,
            stepId: step.id,
            assigneeGezelId: gateAssignee,
            gateSummary: `Attempt ${attempt}/${gate.maxAttempts}. Latest rejection: ${rawMessage}`,
            signals: {
              attempt,
              maxAttempts: gate.maxAttempts,
              escalationStage: stage,
              plateauScore: score,
              ...(failedLabels.length > 0 ? { failedChecks: failedLabels } : {}),
            },
          })
          .catch((err: unknown) => {
            log.warn(
              `[gate] keurmeester consult threw: ${err instanceof Error ? err.message : err}`,
            );
            return null;
          });
        if (consult?.applied) {
          if (consult.action === 'takeover_step' && consult.takeoverAdvanced) {
            // The takeover completed the step through its own gated
            // completion path — this (stale) attempt must not also
            // write or pause. Report held-without-pause; the task has
            // already moved on.
            await logGated('reject', attempt, false, outcome);
            return {
              kind: 'held',
              task: updated,
              info: {
                message,
                messageFingerprint: fingerprint,
                attempt,
                maxAttempts: gate.maxAttempts,
                paused: false,
                cached: false,
                ...(outcome.checkResults ? { checkResults: outcome.checkResults } : {}),
              },
            };
          }
          if (consult.action !== 'takeover_step') {
            // Corrective message or rewrite: fresh gate budget so the
            // revised step gets a real second chance, then keep going.
            await this.resetStepRecoveryBudget(projectId, task.num, step.id, {
              clearGateAttempts: true,
            });
            log.info(
              `[gate] ${task.ref} step "${step.id}": keurmeester ${consult.action} applied — gate budget reset, task stays active`,
            );
            await logGated('reject', attempt, false, outcome);
            return {
              kind: 'held',
              task: updated,
              info: {
                message,
                messageFingerprint: fingerprint,
                attempt,
                maxAttempts: gate.maxAttempts,
                paused: false,
                cached: false,
                ...(outcome.checkResults ? { checkResults: outcome.checkResults } : {}),
              },
            };
          }
          // Failed takeover: its inner gate evaluation may already have
          // paused the task — fall through to the pause path, which is
          // idempotent and correct (the whole ladder is spent).
        }
      }
      await this.setStatus(projectId, task.num, 'paused').catch(() => {});
      log.warn(
        `[gate] ${task.ref} step "${step.id}" rejected ${attempt}× — pausing the task for help`,
      );
      // Pause WITH the investigation done: the trail note tells whoever
      // resumes (user or a stronger model) what was tried and what the
      // gate said each time, instead of a bare "paused" status.
      if (newTrail.length >= 2) {
        await this.appendNote(projectId, task.num, {
          text: buildPlateauDiagnosisNote({
            stepName: step.name,
            stepId: step.id,
            trail: newTrail,
            lastMessage: rawMessage,
          }),
          author: { kind: 'user' },
          stepId: step.id,
        }).catch(() => {});
      }
      await logGated(
        'reject',
        attempt,
        true,
        outcome,
        stage > 0 ? { escalationStage: 3 } : undefined,
      );
      await this.emitNeedsHelp({
        projectId,
        task,
        stepId: step.id,
        reason: stage === 3 && attempt < gate.maxAttempts ? 'gate_plateau' : 'gate_exhausted',
        detail: `Gate rejected ${attempt}/${gate.maxAttempts}: ${rawMessage.split('\n')[0] ?? ''}`,
      });
      return {
        kind: 'held',
        task: { ...updated, status: 'paused' },
        info: {
          message,
          messageFingerprint: fingerprint,
          attempt,
          maxAttempts: gate.maxAttempts,
          paused: true,
          cached: false,
          ...(outcome.checkResults ? { checkResults: outcome.checkResults } : {}),
          ...(stage > 0 ? { escalationStage: 3 as EscalationStage } : {}),
        },
      };
    }

    const loopTarget = outcome.goto ?? gate.onReject;
    if (loopTarget) {
      updated = await this.reactivateStepForGate(projectId, updated, loopTarget, step, cause);
    }
    await logGated(
      'reject',
      attempt,
      false,
      outcome,
      stage > 0 ? { escalationStage: stage } : undefined,
    );
    return {
      kind: 'held',
      task: updated,
      info: {
        message,
        messageFingerprint: fingerprint,
        attempt,
        maxAttempts: gate.maxAttempts,
        paused: false,
        cached: false,
        ...(outcome.checkResults ? { checkResults: outcome.checkResults } : {}),
        ...(stage > 0 ? { escalationStage: stage } : {}),
      },
    };
  }

  /**
   * A rejected gate is unsatisfiable when a FAILING check reads the
   * workspace tree while gezel workspace writes are off for the project
   * (gate scripts always read the workspace, so a script rejection
   * qualifies too). Returns the workspace files the failing checks name
   * (possibly empty), or null when the gate is repairable. Drawer-only
   * failures stay repairable — the artifacts drawer is deliberately
   * exempt from the writes-off policy.
   */
  /**
   * The workspace files a step must produce that no assignee is able to
   * write. The proactive twin of {@link unsatisfiableWorkspaceGateFiles}:
   * that one reads a gate REJECTION, this one reads the step's own
   * deliverable declaration at ACTIVATION, before anyone is dispatched.
   *
   * Wild-caught (Pull Request Review on a writes-off project): the step
   * mandated `write_file pr-review.md` from a roster the workspace-write
   * ceiling had already stripped it from. Nothing could complete the
   * step, so the gezel stalled on a clarifying question and the task sat
   * active indefinitely — the reactive pause never fires because it needs
   * an `advance_task_step` call that never comes.
   */
  private async unsatisfiableStepWorkspaceFiles(
    projectId: string,
    step: Pick<TaskCraftbookStep, 'advanceWhen' | 'gate'>,
  ): Promise<string[] | null> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project || projectManagedWorkspaceWritable(project)) return null;
    const files = new Set<string>();
    if (step.advanceWhen?.file && step.advanceWhen.artifact !== true) {
      files.add(step.advanceWhen.file);
    }
    for (const check of step.gate ? normalizeStepGate(step.gate).checks : []) {
      if ((check as { artifact?: boolean }).artifact === true) continue;
      const file = (check as { file?: string }).file;
      if (file) files.add(file);
    }
    if (files.size === 0) return null;
    // Only a deliverable that must be WRITTEN is unwinnable. A gate over
    // a file that already exists may pass on its contents alone (a
    // verify-only step), so leave that judgement to the gate itself —
    // `requireChange` is the exception, since it demands an edit.
    if (step.advanceWhen?.requireChange !== true) {
      const missing = await Promise.all(
        [...files].map(
          async (file) =>
            (await this.store.readProjectWorkspaceFile(projectId, file).catch(() => null)) === null,
        ),
      );
      if (!missing.some(Boolean)) return null;
    }
    return [...files];
  }

  /**
   * Pause a task whose newly-activated step targets an unwritable
   * workspace deliverable, and report why. Returns true when the caller
   * must skip the handoff — dispatching a gezel here cannot succeed.
   */
  private async pauseIfStepUnsatisfiable(
    projectId: string,
    task: Task,
    step: Pick<TaskCraftbookStep, 'id' | 'name' | 'advanceWhen' | 'gate'>,
  ): Promise<boolean> {
    const files = await this.unsatisfiableStepWorkspaceFiles(projectId, step);
    if (!files) return false;
    const fileList = files.map((f) => `\`${f}\``).join(', ');
    await this.setStatus(projectId, task.num, 'paused').catch(() => {});
    await this.appendNote(projectId, task.num, {
      text: `# Step unsatisfiable — task paused\n\nStep "${step.name}" (\`${step.id}\`) must produce workspace ${fileList}, but managed workspace writes are OFF for this project — no managed task assignee has \`write_file\`, so the step cannot complete through this path. The step was not dispatched.\n\nFix one of these, then set the task active again:\n\n- Enable "${MANAGED_WORKSPACE_WRITE_SETTING_LABEL}" in Project → Settings.\n- Change the step's deliverable to the artifacts drawer (\`artifact: true\`, written with \`write_artifact\`) — the drawer stays writable when workspace writes are off.\n- Create the file(s) by hand and re-run the step.`,
      author: { kind: 'user' },
      stepId: step.id,
    }).catch(() => {});
    log.warn(
      `[tasks] ${task.ref} step "${step.id}" targets workspace ${fileList} but workspace writes are off — pausing instead of dispatching`,
    );
    await this.emitNeedsHelp({
      projectId,
      task,
      stepId: step.id,
      reason: 'gate_unsatisfiable',
      detail: `Step "${step.name}" must write workspace ${fileList}, but managed workspace writes are off for this project.`,
    });
    return true;
  }

  private async unsatisfiableWorkspaceGateFiles(
    projectId: string,
    gate: NormalizedStepGate,
    outcome: StepGateOutcome,
  ): Promise<string[] | null> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project || projectManagedWorkspaceWritable(project)) return null;
    const workspaceChecks = new Map<string, string | undefined>();
    for (const c of gate.checks) {
      if ((c as { artifact?: boolean }).artifact === true) continue;
      workspaceChecks.set(gateCheckLabel(c), (c as { file?: string }).file);
    }
    const failingWorkspace = (outcome.checkResults ?? []).filter(
      (o) => !o.ok && workspaceChecks.has(o.label),
    );
    const scriptRejected = outcome.runs.some((r) => r.decision === 'reject');
    if (failingWorkspace.length === 0 && !scriptRejected) return null;
    return [...new Set(failingWorkspace.map((o) => o.file).filter((f): f is string => !!f))];
  }

  /**
   * Gate-driven loop-back: re-activate `targetId` WITHOUT completing the
   * gated step. Unlike `activateStep`, this bumps + fires the handoff
   * hook even when the target IS the gated step itself — `onReject:
   * <self>` deliberately produces a fresh activation + handoff session
   * each rejection (the loop shape that carries small models).
   */
  private async reactivateStepForGate(
    projectId: string,
    task: Task,
    targetId: string,
    gatedStep: TaskCraftbookStep,
    cause?: CompleteStepOpts['cause'],
  ): Promise<Task> {
    const target = task.craftbook.steps.find((s) => s.id === targetId);
    if (!target) {
      log.error(`[gate] ${task.ref}: reject route "${targetId}" missing — staying on step`);
      return task;
    }
    const now = nowIso();
    const next: Task = {
      ...task,
      craftbook: {
        ...task.craftbook,
        steps: bumpStepActivation(task.craftbook.steps, targetId, now),
        updatedAt: now,
      },
      activeStepId: targetId,
      updatedAt: now,
    };
    await this.store.writeTask(next);
    const newStep = next.craftbook.steps.find((s) => s.id === targetId);
    // Model/tool and observable-progress attempts already have a live chat
    // turn that receives the gate verdict and continues the repair loop.
    // Claim the fresh activation for that dispatch immediately after the
    // durable task write. Without this handoff, TaskRunner sees the changed
    // `lastActivatedAt` on its next prune and cancels the healthy turn as a
    // stale activation.
    const currentTurnOwnsRecovery = cause === 'model' || cause === 'auto';
    if (newStep && currentTurnOwnsRecovery && this.onCurrentTurnStepReactivated) {
      try {
        this.onCurrentTurnStepReactivated({
          projectId,
          task: next,
          newStep,
          gatedStep,
        });
      } catch (err) {
        log.error('[tasks] current-turn step reactivation hook failed:', err);
      }
    }
    await this.reactivateProject(projectId);
    await this.history?.log({
      kind: 'task.step.activated',
      projectId,
      summary: `Gate looped ${next.ref} back to "${target.name}"`,
      details: { ref: next.ref, stepId: targetId },
    });
    // Model/tool and observable-progress attempts already have a live chat
    // turn that receives the gate verdict and continues the repair loop.
    // Starting a second handoff here creates two workers for the same
    // activation. Non-chat drivers (idle sweep/user/runtime routing) still
    // need a fresh handoff because no current model turn can consume it.
    if (newStep && this.onStepActivated && !currentTurnOwnsRecovery) {
      try {
        await this.onStepActivated({ projectId, task: next, newStep, completedStep: gatedStep });
      } catch (err) {
        log.error('[tasks] onStepActivated hook failed:', err);
      }
    }
    return next;
  }

  /**
   * Execute one gate script. Policy: `standard`-scope scripts are packed
   * into the app and trusted — they run even when engagement/security
   * settings disable user script execution. Everything else returns
   * `'skipped'` under those settings (fail-open; the engine reports the
   * skip so a note makes it visible).
   */
  private async runGateScript(
    projectId: string,
    task: Task,
    step: TaskCraftbookStep,
    ref: GateScriptRef,
  ): Promise<ScriptRun | 'skipped'> {
    if (!this.scriptRunner) return 'skipped';
    if (ref.scope !== 'standard') {
      const config = await this.store.readConfig();
      if (!isEngagementAllowed(config)) return 'skipped';
    }
    return this.scriptRunner.run({
      projectId,
      scriptName: ref.name,
      ...(ref.scope ? { scope: ref.scope } : {}),
      ...(this.embeddedScriptSource(task, ref) ?? {}),
      inputs: ref.inputs,
      trigger: { kind: 'step', taskRef: task.ref, stepId: step.id, moment: 'gate' },
    });
  }

  /**
   * A `scope: 'craftbook'` ref resolves against the task snapshot's
   * embedded scripts map first — the task carries its own sources, so a
   * template edit never reshapes a running gate. Absent from the map (or
   * a legacy snapshot with no map at all) → undefined, and the runner
   * falls back to the project-installed copy (scripts/install.ts).
   */
  private embeddedScriptSource(
    task: Task,
    ref: { name: string; scope?: string },
  ): { inlineSource: string } | undefined {
    if (ref.scope !== 'craftbook') return undefined;
    const source = task.craftbook.scripts?.[ref.name];
    return source !== undefined ? { inlineSource: source } : undefined;
  }

  /**
   * Execute a step-attached script with the right trigger metadata.
   * Returns `null` when the runner isn't wired or engagement mode is
   * off — callers treat null as "no script ran".
   */
  private async runStepScript(
    projectId: string,
    task: Task,
    step: TaskCraftbookStep,
    moment: 'enter' | 'exit',
    ref: ScriptRef,
  ): Promise<ScriptRun | null> {
    if (!this.scriptRunner) return null;
    const config = await this.store.readConfig();
    if (!isEngagementAllowed(config)) return null;
    return this.scriptRunner.run({
      projectId,
      scriptName: ref.name,
      ...(ref.scope ? { scope: ref.scope } : {}),
      ...(this.embeddedScriptSource(task, ref) ?? {}),
      inputs: ref.inputs,
      trigger: { kind: 'step', taskRef: task.ref, stepId: step.id, moment },
    });
  }

  // ── Notes / sessions ───────────────────────────────────────────

  async listNotes(projectId: string, num: number, stepId?: string): Promise<TaskNote[]> {
    return this.store.listTaskNotes(projectId, num, stepId);
  }

  async appendNote(
    projectId: string,
    num: number,
    input: { text: string; author: TaskNoteAuthor; stepId?: string },
  ): Promise<TaskNote> {
    const note: TaskNote = {
      id: randomUUID().slice(0, 12),
      at: nowIso(),
      author: input.author,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      text: input.text,
    };
    await this.store.appendTaskNote(projectId, num, note);
    const ref = buildTaskRef(projectId, num);
    const authorName = note.author.kind === 'user' ? 'the user' : note.author.name;
    const firstLine = note.text.split('\n')[0]?.slice(0, 80) ?? '';
    await this.history?.log({
      kind: 'tasknote.appended',
      projectId,
      ...(note.author.kind === 'gezel' ? { gezelId: note.author.gezelId } : {}),
      summary: `${authorName} noted on ${ref}: ${firstLine}`,
      details: {
        ref,
        noteId: note.id,
        ...(note.stepId ? { stepId: note.stepId } : {}),
      },
    });
    return note;
  }

  async deleteNote(
    projectId: string,
    num: number,
    noteId: string,
    actor: TaskNoteAuthor,
  ): Promise<TaskNote | null> {
    const removed = await this.store.deleteTaskNote(projectId, num, noteId);
    if (!removed) return null;
    const ref = buildTaskRef(projectId, num);
    const actorName = actor.kind === 'user' ? 'the user' : actor.name;
    await this.history?.log({
      kind: 'tasknote.deleted',
      projectId,
      ...(actor.kind === 'gezel' ? { gezelId: actor.gezelId } : {}),
      summary: `${actorName} removed a note from ${ref}`,
      details: { ref, noteId },
    });
    return removed;
  }

  async updateNote(
    projectId: string,
    num: number,
    noteId: string,
    text: string,
    actor: TaskNoteAuthor,
  ): Promise<TaskNote | null> {
    const updated = await this.store.updateTaskNote(projectId, num, noteId, text);
    if (!updated) return null;
    const ref = buildTaskRef(projectId, num);
    const actorName = actor.kind === 'user' ? 'the user' : actor.name;
    const firstLine = text.split('\n')[0]?.slice(0, 80) ?? '';
    await this.history?.log({
      kind: 'tasknote.updated',
      projectId,
      ...(actor.kind === 'gezel' ? { gezelId: actor.gezelId } : {}),
      summary: `${actorName} edited a note on ${ref}: ${firstLine}`,
      details: { ref, noteId },
    });
    return updated;
  }

  async listSessions(projectId: string, num: number): Promise<ChatSessionSummary[]> {
    const ref = buildTaskRef(projectId, num);
    const all = await this.store.listSessions({ projectId });
    return all.filter((s) => s.taskRef === ref);
  }

  // ── Children / spawn / fanout ──────────────────────────────────

  async listChildren(
    parentRef: string,
    opts: { status?: TaskStatus; limit?: number } = {},
  ): Promise<Task[]> {
    const parsed = parseTaskRef(parentRef);
    if (!parsed) return [];
    const all = await this.store.listProjectTasks(parsed.projectId);
    let children = all.filter((t) => t.parentTaskRef === parentRef);
    if (opts.status) children = children.filter((t) => t.status === opts.status);
    children.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (opts.limit && opts.limit > 0) children = children.slice(0, opts.limit);
    return children;
  }

  /**
   * Clone the parent's spawn craftbook into a fresh child task. Child
   * starts at `status: 'active'` with the spawn craftbook's entry step
   * active, which fires the `onStepActivated` hook.
   */
  async spawnChild(parentRef: string, variation?: TaskVariation): Promise<Task> {
    const parent = await this.getByRef(parentRef);
    if (!parent) throw new Error(`task ${parentRef} not found`);
    if (!parent.spawnsCraftbook) {
      throw new Error(`task ${parentRef} has no spawn craftbook`);
    }
    if (parent.spawnsCraftbook.steps.length === 0) {
      throw new Error(`task ${parentRef} spawn craftbook has no steps`);
    }
    const now = nowIso();
    const num = await this.store.nextProjectTaskNum(parent.projectId);

    // Re-snapshot the spawn craftbook so child step lifecycle fields are
    // fresh and the child can mutate without rippling back to the host.
    const childCraftbook = snapshotCraftbookForTask(
      {
        ...parent.spawnsCraftbook,
        steps: parent.spawnsCraftbook.steps.map((s) => {
          // Strip per-instance lifecycle off the host's spawn snapshot
          // so the child gets a clean recipe view.
          const {
            createdAt: _ca,
            completedAt: _co,
            attemptCount: _ac,
            lastActivatedAt: _la,
            ...recipe
          } = s;
          void _ca;
          void _co;
          void _ac;
          void _la;
          return recipe;
        }),
      },
      now,
    );
    // Land the per-child context in the recipe itself: {{client}} etc. in
    // step prompts and gate/advanceWhen file paths become the concrete
    // values BEFORE the child is written + dispatched, so the child's turn
    // and its gate both see the resolved per-item data.
    if (variation?.context) interpolateStepsContext(childCraftbook.steps, variation.context);
    const activeStepId = childCraftbook.entryStepId;
    // First activation of the child's entry step → attemptCount 1.
    childCraftbook.steps = bumpStepActivation(childCraftbook.steps, activeStepId, now);
    const firstStep = childCraftbook.steps.find((s) => s.id === activeStepId)!;

    // Inherited assignee: explicit step assignee → suggestedGezelId →
    // craftbook default → parent's assignee.
    const inheritedAssignee: TaskAssignee =
      firstStep.assignee ??
      (firstStep.suggestedGezelId
        ? { kind: 'gezel', gezelId: firstStep.suggestedGezelId }
        : (childCraftbook.defaultAssignee ?? parent.assignee));

    // A child dispatches off its ENTRY STEP's binding — `onStepActivated`
    // reads the step's assignee/suggestedGezelId, never the task assignee.
    // A role-only or binding-less spawn step therefore clones into a child
    // that never gets a turn, and the whole fanout silently stalls
    // (wild-caught: a per-client invoice fanout where role-only children
    // sat idle). `create()` resolves the entry step's role for exactly
    // this reason; mirror it here, then fall back to the inherited assignee
    // so the entry step always carries a concrete gezel to dispatch to.
    await this.maybeResolveStepRole(childCraftbook, activeStepId, parent.projectId);
    if (!firstStep.assignee && !firstStep.suggestedGezelId && inheritedAssignee.kind === 'gezel') {
      firstStep.suggestedGezelId = inheritedAssignee.gezelId;
    }

    const title = variation?.title ?? parent.title;
    const description = variation?.description ?? childCraftbook.description ?? parent.description;
    const plan = variation?.plan ?? childCraftbook.plan ?? parent.plan;

    // Carry the spawn-source provenance forward as the child's main role.
    const parentSpawnSource = parent.sourceCraftbookIds?.find((s) => s.role === 'spawn');
    const childSources: TaskCraftbookSource[] = parentSpawnSource
      ? [
          {
            role: 'main',
            catalogId: parentSpawnSource.catalogId,
            ...(parentSpawnSource.version ? { version: parentSpawnSource.version } : {}),
            ...(parentSpawnSource.sourceId ? { sourceId: parentSpawnSource.sourceId } : {}),
          },
        ]
      : [];

    const child: Task = {
      projectId: parent.projectId,
      num,
      ref: buildTaskRef(parent.projectId, num),
      title,
      ...(description ? { description } : {}),
      ...(plan ? { plan } : {}),
      status: 'active',
      assignee: inheritedAssignee,
      craftbook: childCraftbook,
      ...(childSources.length > 0 ? { sourceCraftbookIds: childSources } : {}),
      ...(parent.spawnsCraftbookParams ? { craftbookParams: parent.spawnsCraftbookParams } : {}),
      // A child of a night-shift host is itself night-shift work — the
      // runner gates its dispatch to an active shift. The child is a plain
      // task (no cron/spawn), so `onceADay` doesn't carry over.
      ...(parent.nightShift?.enabled ? { nightShift: { enabled: true } } : {}),
      activeStepId,
      parentTaskRef: parent.ref,
      createdAt: now,
      updatedAt: now,
      createdBy: parent.createdBy,
    };
    await this.store.writeTask(child);

    // If the variation includes context, append it as a step-0 note so
    // the gezel receiving the handoff can see per-child parameters.
    if (variation?.context && Object.keys(variation.context).length > 0) {
      const lines = ['# Instance context', ''];
      for (const [k, v] of Object.entries(variation.context)) {
        lines.push(`- **${k}**: ${v}`);
      }
      lines.push('');
      try {
        await this.appendNote(child.projectId, child.num, {
          text: lines.join('\n'),
          author: { kind: 'user' },
          stepId: activeStepId,
        });
      } catch (err) {
        log.warn(
          `[tasks] failed to write variation context notes for ${child.ref}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    await this.history?.log({
      kind: 'task.instance.spawned',
      projectId: parent.projectId,
      ...(child.assignee.kind === 'gezel' ? { gezelId: child.assignee.gezelId } : {}),
      summary: `Spawned ${child.ref} from ${parent.ref}`,
      details: { parentRef: parent.ref, childRef: child.ref, title: child.title },
    });

    if (this.onStepActivated) {
      try {
        await this.onStepActivated({
          projectId: child.projectId,
          task: child,
          newStep: firstStep,
          completedStep: firstStep,
        });
      } catch (err) {
        log.error('[tasks] onStepActivated hook failed on spawnChild:', err);
      }
    }
    return child;
  }

  /**
   * Create declarative-fanout children from the parent's `fanout` config
   * (if unmaterialized). Idempotent: once `materializedAt` is set,
   * calling again is a no-op.
   */
  async materializeFanout(
    projectId: string,
    num: number,
  ): Promise<{ parent: Task; children: Task[] }> {
    const parent = await this.requireTask(projectId, num);
    if (!parent.fanout) return { parent, children: [] };
    if (parent.fanout.materializedAt) return { parent, children: [] };
    if (!parent.spawnsCraftbook) {
      throw new Error(`task ${parent.ref}: fanout requires a spawn craftbook`);
    }
    const { count, variations } = parent.fanout;
    const children: Task[] = [];
    for (let i = 0; i < count; i++) {
      const variation = variations?.[i];
      children.push(await this.spawnChild(parent.ref, variation));
    }
    const updatedParent = await this.requireTask(projectId, num);
    const withStamp: Task = {
      ...updatedParent,
      fanout: {
        ...parent.fanout,
        materializedAt: nowIso(),
      },
      updatedAt: nowIso(),
    };
    await this.store.writeTask(withStamp);
    await this.history?.log({
      kind: 'task.fanout.materialized',
      projectId,
      summary: `Materialized ${children.length} instance(s) of ${parent.ref}`,
      details: {
        ref: parent.ref,
        count: children.length,
        childRefs: children.map((c) => c.ref),
      },
    });
    return { parent: withStamp, children };
  }

  /**
   * Imperative fanout: spawn N children on demand. Used by the
   * `spawn_task_instances` MCP tool and the "Spawn instance" UI button.
   */
  async spawnInstances(
    parentRef: string,
    count: number,
    variations?: TaskVariation[],
  ): Promise<Task[]> {
    const children: Task[] = [];
    for (let i = 0; i < count; i++) {
      const variation = variations?.[i];
      children.push(await this.spawnChild(parentRef, variation));
    }
    return children;
  }

  // ── Scheduler hook ─────────────────────────────────────────────

  async recordCronTick(task: Task): Promise<Task> {
    if (!task.cron) return task;
    const schedule = parseCron(task.cron.expression);
    const now = new Date();
    const updated: Task = {
      ...task,
      cron: {
        expression: task.cron.expression,
        lastTickAt: now.toISOString(),
        nextTickAt: nextCronFire(schedule, now).toISOString(),
        ...(task.cron.overlap ? { overlap: task.cron.overlap } : {}),
      },
      updatedAt: now.toISOString(),
    };
    await this.store.writeTask(updated);
    const activeStep = task.craftbook.steps.find((s) => s.id === task.activeStepId);
    await this.history?.log({
      kind: 'task.tick',
      projectId: task.projectId,
      ...(task.assignee.kind === 'gezel' ? { gezelId: task.assignee.gezelId } : {}),
      summary: `Tick on ${task.ref} — "${task.title}" (step: ${activeStep?.name ?? task.activeStepId})`,
      details: {
        ref: task.ref,
        activeStepId: task.activeStepId,
        expression: task.cron.expression,
      },
    });
    return updated;
  }

  /**
   * Stamp a night-shift spawn host's `lastRunDay` with the current night
   * window's day key. Called by the scheduler at child-spawn time — the
   * host's placeholder step never completes, so the step-completion
   * stamping path can't reach it. Together with the scheduler's guard
   * this gives `onceADay` hosts "at most one spawn per night window".
   */
  async recordNightShiftSpawn(ref: string, dayKey: string): Promise<void> {
    const task = await this.getByRef(ref);
    if (!task?.nightShift) return;
    await this.store.writeTask({
      ...task,
      nightShift: { ...task.nightShift, lastRunDay: dayKey },
      updatedAt: new Date().toISOString(),
    });
  }

  describeAssignee = describeAssignee;

  private async requireTask(projectId: string, num: number): Promise<Task> {
    const task = await this.store.readTask(projectId, num);
    if (!task) throw new Error(`task ${buildTaskRef(projectId, num)} not found`);
    return task;
  }
}

/**
 * Walk a step's branches in order, evaluating each predicate against
 * the supplied output. Returns the first matching `goto`, or undefined
 * when no branch matches (caller falls through to `next`).
 */
function findBranchGoto(
  branches: { when: ScriptOutputPredicate; goto: string }[],
  output: unknown,
): string | undefined {
  for (const b of branches) {
    if (evaluatePredicate(b.when, output)) return b.goto;
  }
  return undefined;
}

/**
 * Stamp an activation onto a step: bump `attemptCount` and set
 * `lastActivatedAt`. Called every time a step becomes the active step —
 * the entry step at create/spawn, manual `activateStep`, and each
 * advancement, INCLUDING loop-backs (build-loop's `evaluate → build`
 * cycle re-activates `build`, so its count climbs). The count is what
 * surfaces "we've poked the dev step 3 times" to the voorman and lets
 * the eval harness confirm a model iterated rather than one-shotting.
 */
function bumpStepActivation(
  steps: TaskCraftbookStep[],
  stepId: string,
  at: string,
): TaskCraftbookStep[] {
  return steps.map((s) => {
    if (s.id !== stepId) return s;
    // A re-activated step (loop-back) is active again, not done — drop any
    // stale `completedAt` from its previous pass so the phase state reads
    // truthfully — and bump the attempt counter. Gate state resets too:
    // a fresh activation grants a fresh rejection budget, and the damper
    // must not replay a rejection from a previous pass. The anti-stall
    // re-drive budget resets on the same principle — a fresh activation is
    // a clean start, not a continuation of the prior pass's silence.
    //
    // `gateAttemptHistory` deliberately SURVIVES this reset: `onReject:
    // <self>` loop gates re-activate on every rejection, so stripping the
    // trail here would blind the plateau ladder exactly where it matters.
    // The trail self-heals — real progress changes the failing-check
    // signature and the trailing-run score resets to 1.
    const {
      completedAt: _done,
      gateAttempts: _ga,
      lastGateReject: _lgr,
      redriveCount: _rc,
      lastRedriveAt: _lra,
      ...rest
    } = s;
    void _done;
    void _ga;
    void _lgr;
    void _rc;
    void _lra;
    return { ...rest, attemptCount: (s.attemptCount ?? 0) + 1, lastActivatedAt: at };
  });
}

/**
 * Decide whether a step should auto-advance based on its onEnter ref
 * and the stamped output. `autoAdvanceOnSuccess: true` is sugar for
 * `{op: 'ok'}`. If both flags are set, `autoAdvanceWhen` wins.
 */
function shouldAutoAdvance(ref: ScriptRef, output: unknown): boolean {
  const predicate: ScriptOutputPredicate | undefined =
    ref.autoAdvanceWhen ?? (ref.autoAdvanceOnSuccess ? { op: 'ok' } : undefined);
  if (!predicate) return false;
  return evaluatePredicate(predicate, output);
}

function evaluatePredicate(predicate: ScriptOutputPredicate, output: unknown): boolean {
  switch (predicate.op) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'ok': {
      if (!isRecord(output)) return true;
      return output.ok !== false;
    }
    case 'equals': {
      const v = readFieldPath(output, predicate.field);
      return v === predicate.value;
    }
    case 'exists': {
      const v = readFieldPath(output, predicate.field);
      const exists = v !== undefined && v !== null;
      return predicate.negate ? !exists : exists;
    }
    case 'gt': {
      const v = readFieldPath(output, predicate.field);
      return typeof v === 'number' && v > predicate.value;
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readFieldPath(output: unknown, path: string): unknown {
  if (output === null || output === undefined) return undefined;
  const segments = path.split('.');
  let cur: unknown = output;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && seg === 'length') {
      cur = cur.length;
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * The gezel accountable for a step right now: explicit step assignee →
 * the step's resolved suggested gezel → the task-level assignee. Same
 * triple the scheduler and the gate's keurmeester consult use.
 */
export function stepOwnerGezelId(task: Task, step: TaskCraftbookStep): string | undefined {
  if (step.assignee?.kind === 'gezel') return step.assignee.gezelId;
  if (step.suggestedGezelId) return step.suggestedGezelId;
  return task.assignee.kind === 'gezel' ? task.assignee.gezelId : undefined;
}

/**
 * The catalog identity of the recipe this task walks — the per-book join
 * key gate telemetry aggregates on. `role: 'main'` is the walked book;
 * the embedded snapshot id is the fallback for older/inline tasks.
 */
export function mainBookSource(task: Task): { catalogId: string; version?: string } {
  const main = task.sourceCraftbookIds?.find((s) => s.role === 'main');
  if (main) {
    return { catalogId: main.catalogId, ...(main.version ? { version: main.version } : {}) };
  }
  return { catalogId: task.craftbook.id };
}
