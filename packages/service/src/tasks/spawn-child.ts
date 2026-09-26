import {
  type Task,
  type TaskAssignee,
  type TaskCraftbook,
  type TaskCraftbookSource,
  type TaskCraftbookStep,
  type TaskVariation,
  taskRef as buildTaskRef,
} from '@bendyline/gezel';
import { interpolateStepsContext, snapshotCraftbookForTask } from './craftbook-instantiation.js';
import { bumpStepActivation } from './step-runtime.js';

/**
 * Cloning a fanout host's spawn craftbook into one child task: every field a
 * shard inherits from its host, and why. The pure half of
 * `TaskManager.spawnChild` — numbering, role resolution, persistence, and the
 * activation hooks stay in the manager.
 */

/**
 * Re-snapshot the host's spawn craftbook for one child, so the child's step
 * lifecycle fields are fresh and it can mutate without rippling back to the
 * host. The entry step comes back already activated (attemptCount 1).
 */
export function snapshotSpawnCraftbook(
  parent: Task,
  spawnsCraftbook: TaskCraftbook,
  childNum: number,
  variation: TaskVariation | undefined,
  now: string,
): { craftbook: TaskCraftbook; entryStep: TaskCraftbookStep } {
  const craftbook = snapshotCraftbookForTask(
    {
      ...spawnsCraftbook,
      steps: spawnsCraftbook.steps.map((s) => {
        // Strip per-instance lifecycle off the host's spawn snapshot
        // so the child gets a clean recipe view.
        const {
          createdAt: _ca,
          completedAt: _co,
          attemptCount: _ac,
          lastActivatedAt: _la,
          onEnterCompletedAt: _entered,
          ...recipe
        } = s;
        void _ca;
        void _co;
        void _ac;
        void _la;
        void _entered;
        return recipe;
      }),
    },
    now,
  );
  // Land the per-child context in the recipe itself: {{client}} etc. in
  // step prompts and gate/advanceWhen file paths become the concrete
  // values BEFORE the child is written + dispatched, so the child's turn
  // and its gate both see the resolved per-item data.
  // A shard of a proposal-drafting host writes into its OWN proposal, whose
  // id is this child's task number. `{{task.num}}` cannot express that:
  // `create()` already interpolated the spawn template with the HOST's
  // context, so every shard would silently target the host's pack. Hence a
  // dedicated token resolved here, where the child's number is known.
  const shardContext: Record<string, string> = {
    ...(variation?.context ?? {}),
    ...(parent.diffpackId
      ? { 'diffpack.id': String(childNum), 'diffpack.dir': `diffpacks/${childNum}` }
      : {}),
  };
  if (Object.keys(shardContext).length > 0) {
    interpolateStepsContext(craftbook.steps, shardContext);
  }
  craftbook.steps = bumpStepActivation(craftbook.steps, craftbook.entryStepId, now);
  const entryStep = craftbook.steps.find((s) => s.id === craftbook.entryStepId)!;
  return { craftbook, entryStep };
}

/**
 * Inherited assignee: explicit step assignee → suggestedGezelId →
 * craftbook default → parent's assignee.
 */
export function inheritedChildAssignee(
  entryStep: TaskCraftbookStep,
  craftbook: TaskCraftbook,
  parent: Task,
): TaskAssignee {
  return (
    entryStep.assignee ??
    (entryStep.suggestedGezelId
      ? { kind: 'gezel', gezelId: entryStep.suggestedGezelId }
      : (craftbook.defaultAssignee ?? parent.assignee))
  );
}

export function buildSpawnedChildTask(opts: {
  parent: Task;
  num: number;
  craftbook: TaskCraftbook;
  assignee: TaskAssignee;
  variation: TaskVariation | undefined;
  now: string;
}): Task {
  const { parent, num, craftbook, assignee, variation, now } = opts;
  const title = variation?.title ?? parent.title;
  const description = variation?.description ?? craftbook.description ?? parent.description;
  const plan = variation?.plan ?? craftbook.plan ?? parent.plan;

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

  return {
    projectId: parent.projectId,
    num,
    ref: buildTaskRef(parent.projectId, num),
    title,
    ...(description ? { description } : {}),
    ...(plan ? { plan } : {}),
    status: 'active',
    assignee,
    // Same run, same mode — never re-resolved for a child.
    ...(parent.executionMode ? { executionMode: parent.executionMode } : {}),
    craftbook,
    ...(parent.cliTrustedScriptHashes
      ? { cliTrustedScriptHashes: parent.cliTrustedScriptHashes }
      : {}),
    ...(childSources.length > 0 ? { sourceCraftbookIds: childSources } : {}),
    ...(parent.spawnsCraftbookParams ? { craftbookParams: parent.spawnsCraftbookParams } : {}),
    // A shard works on its host's input; its template already carries those paths.
    ...(parent.inputs ? { inputs: parent.inputs } : {}),
    ...(parent.references ? { references: parent.references } : {}),
    // `packId` is the reserved diffpack binding (see `resolveDiffpackId`):
    // a shard that carries one drafts into that change proposal, so its
    // workspace-write tools re-root at the pack instead of the workspace.
    // Per-child, because a fanout exists precisely to give each cluster of
    // issues its own reviewable proposal.
    // A shard of a proposal-drafting host drafts its OWN proposal — one per
    // cluster, which is why the fanout exists. Derived from the child's task
    // number rather than passed in: if this were model-supplied, a mangled
    // value would silently unbind the child and send its edits to the real
    // workspace, which is the one outcome this whole feature exists to
    // prevent. Fail-safe, not fail-open.
    ...(parent.diffpackId ? { diffpackId: String(num) } : {}),
    // A child of a night-shift host is itself night-shift work — the
    // runner gates its dispatch to an active shift. The child is a plain
    // task (no cron/spawn), so `onceADay` doesn't carry over.
    ...(parent.nightShift?.enabled ? { nightShift: { enabled: true } } : {}),
    activeStepId: craftbook.entryStepId,
    parentTaskRef: parent.ref,
    // Shards share the HOST's folder: the host's collect-barrier gates
    // were interpolated with the host's number, and per-child files are
    // already namespaced by the variation context ({{batchNumber}}, …).
    artifactDir: parent.artifactDir ?? `tasks/${parent.num}`,
    ...(parent.roleBasedNameOnlyMode !== undefined
      ? { roleBasedNameOnlyMode: parent.roleBasedNameOnlyMode }
      : {}),
    createdAt: now,
    updatedAt: now,
    createdBy: parent.createdBy,
  };
}

/**
 * The step-0 note that shows the gezel receiving the handoff its per-child
 * parameters. Null when the variation carries no context.
 */
export function instanceContextNoteText(variation: TaskVariation | undefined): string | null {
  if (!variation?.context || Object.keys(variation.context).length === 0) return null;
  const lines = ['# Instance context', ''];
  for (const [k, v] of Object.entries(variation.context)) {
    lines.push(`- **${k}**: ${v}`);
  }
  lines.push('');
  return lines.join('\n');
}
