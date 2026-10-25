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
  assignOwnerApprovalSteps,
  expandStepDeliverables,
  interpolateContextDeep,
  interpolateStepsContext,
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
    // The contract the run is held to, whatever strategy runs it.
    ...(book.contract ? { contract: book.contract } : {}),
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
 * Land a launch's context in the task's recipe snapshots: the host's steps
 * and contract, then the fanout half — the `spawn` config and every
 * child-template step and contract. A fanout whose corpus lives at
 * `…/pr-{{number}}/…` once read a path that did not exist, found no items,
 * and logged "skipping fanout" while the host advanced to its collect
 * barrier with no children to wait for: interpolate the whole recipe, not
 * the fields someone remembered. Only ever pass snapshots, never the
 * resolver's cached template, or one task's params leak into the next
 * launch of the same craftbook.
 *
 * The spawn template keeps `{{diffpack.*}}` un-interpolated: those tokens
 * are per-shard (spawnChild resolves them with the child's pack id), and a
 * drafting host's own context would otherwise draft every shard into one
 * pack. Host steps keep the full context (the non-fanout Boekwachter path
 * legitimately addresses its own pack).
 */
export function interpolateLaunchRecipes(
  craftbook: TaskCraftbook,
  spawnsCraftbook: TaskCraftbook | undefined,
  context: Record<string, string>,
): void {
  interpolateStepsContext(craftbook.steps, context);
  if (craftbook.contract) {
    craftbook.contract = interpolateContextDeep(craftbook.contract, context);
  }
  const spawnTemplateContext = Object.fromEntries(
    Object.entries(context).filter(([key]) => !key.startsWith('diffpack.')),
  );
  if (spawnsCraftbook) {
    interpolateStepsContext(spawnsCraftbook.steps, spawnTemplateContext);
    if (spawnsCraftbook.contract) {
      spawnsCraftbook.contract = interpolateContextDeep(
        spawnsCraftbook.contract,
        spawnTemplateContext,
      );
    }
  }
  if (craftbook.spawn) {
    craftbook.spawn = interpolateContextDeep(craftbook.spawn, spawnTemplateContext);
  }
}

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
  const resolved: CraftbookStep[] = expandStepDeliverables(assignOwnerApprovalSteps(steps));
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
