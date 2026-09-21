import { randomUUID } from 'node:crypto';
import {
  type Craftbook,
  type CraftbookConnectorNeed,
  type CraftbookStep,
  type CraftbookToolsetNeed,
  type NewCraftbookStep,
  type TaskAssignee,
  type TaskCraftbook,
  type TaskCraftbookStep,
  expandStepDeliverables,
  nowIso,
} from '@bendyline/gezel';

/**
 * Instantiating a craftbook into a task: snapshotting the catalog book into
 * the task's own embedded copy, resolving its launch parameters, and
 * substituting `{{token}}` context through the resulting steps.
 *
 * Split out of `manager.ts` verbatim — the substitution rules here are
 * load-bearing (see each function's notes) and belong together.
 */

/**
 * Produce a TaskCraftbook from a runtime Craftbook by stamping
 * `createdAt` on every step. Used both when resolving from the catalog
 * (the embedded copy gets fresh per-instance lifecycle fields) and when
 * cloning a parent's spawn craftbook into a child.
 */
export function snapshotCraftbookForTask(book: Craftbook, now: string): TaskCraftbook {
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
    ...(book.cliWorkflow ? { cliWorkflow: book.cliWorkflow } : {}),
    // Snapshot toolsets so ChatManager can derive the auto-allow tool set
    // from `task.craftbook.toolsets` without re-resolving the catalog book.
    ...(book.toolsets ? { toolsets: book.toolsets } : {}),
    // Snapshot recommendation hints so the chat's craftbook start card can
    // read them off the tool result's task without a catalog lookup.
    ...(book.recommends ? { recommends: book.recommends } : {}),
    // Snapshot connector needs so a running task records the corpus it was
    // launched against without re-resolving the catalog book.
    ...(book.connectors ? { connectors: book.connectors } : {}),
    // Snapshot command needs so the kickoff hook can raise their first-use
    // approval questions from the task record alone.
    ...(book.commands ? { commands: book.commands } : {}),
    // Snapshot embedded script sources so the task's gate/lifecycle
    // scripts execute from its own copy (scope 'craftbook' refs resolve
    // here first — see runGateScript/runStepScript).
    ...(book.scripts ? { scripts: book.scripts } : {}),
    // Snapshot the declarative per-item fanout config so the runtime reads
    // `task.craftbook.spawn` when the `spawnFanout` step activates.
    ...(book.spawn ? { spawn: book.spawn } : {}),
    // Snapshot the mode-agnostic declaration so the task records that its
    // book allowed drafting (the run's actual mode is `task.diffpackId`).
    ...(book.diffpackCapable ? { diffpackCapable: true } : {}),
    // Snapshot the whole-book floor so dispatch routing reads it from the
    // task record alone (effectiveCapabilityFloor).
    ...(book.capabilityFloor ? { capabilityFloor: book.capabilityFloor } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export {
  craftbookParamDefaults,
  assertCraftbookParamRequirements,
  resolveCraftbookParamDefaults,
  resolveRuntimeTokensInParams,
  interpolateContext,
  interpolateContextDeep,
  interpolateStepsContext,
  taskInterpolationContext,
} from '@bendyline/gezel';

/**
 * Turn an array of inline-step blueprints into a fresh ad-hoc craftbook.
 * Used when `create_task` is called with `steps` instead of a
 * `craftbookId` — the resulting book is embedded directly in the task
 * with no source provenance.
 */
export function inlineStepsToCraftbook(
  steps: NewCraftbookStep[],
  opts: {
    name: string;
    description?: string;
    plan?: string;
    defaultAssignee?: TaskAssignee;
    entryStepId?: string;
    /** Requirements the children inherit — see the `mainBook.spawn` call site. */
    toolsets?: CraftbookToolsetNeed[];
    connectors?: CraftbookConnectorNeed[];
    /** Embedded script sources the children's `scope: 'craftbook'` refs resolve against. */
    scripts?: Record<string, string>;
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
    ...(opts.toolsets ? { toolsets: opts.toolsets } : {}),
    ...(opts.connectors ? { connectors: opts.connectors } : {}),
    ...(opts.scripts ? { scripts: opts.scripts } : {}),
    steps: resolved,
    entryStepId: entry,
    createdAt: now,
    updatedAt: now,
  };
}

export { pinCraftbookOwner } from '@bendyline/gezel';
