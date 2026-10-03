import type {
  CraftbookConnectorNeed,
  Task,
  TaskCraftbookSource,
  TaskCraftbookStep,
  TaskStatus,
} from '@bendyline/gezel';

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
  /** A spawned task's first step is an entry, not a self-handoff. */
  kind?: 'entry' | 'transition' | 'redispatch';
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
  /** `newStep`'s `lastActivatedAt` before this reactivation replaced it. */
  previousActivationAt: string | undefined;
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

/** Fired after the durable status changes, including draft activation. */
export type TaskStatusChangedHook = (ctx: {
  projectId: string;
  task: Task;
  previousStatus: TaskStatus;
}) => Promise<void> | void;

export type TaskNeedsHelpReason =
  | 'gate_exhausted'
  | 'gate_plateau'
  | 'gate_unsatisfiable'
  | 'gate_infrastructure'
  | 'step_exit_infrastructure'
  | 'step_stalled'
  | 'budget_exhausted';

/**
 * Fired when a task PAUSES FOR HELP — a gate budget spent, a plateau, an
 * unsatisfiable-by-policy gate, a lifecycle-script failure, or a stalled
 * assignee. Settle hooks only cover complete/canceled, so without this a
 * background task that hit a wall paused silently: a note on the task and
 * a history row, nothing pushed to the user. `detail` is a one-line human
 * summary of why.
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
