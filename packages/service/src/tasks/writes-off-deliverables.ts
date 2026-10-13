/**
 * Whether a step's deliverable can be produced at all while managed
 * workspace writes are off for its project. The artifacts drawer is exempt
 * from that policy, so only a workspace-tree deliverable can be unwinnable.
 */
import {
  type NormalizedStepGate,
  type Task,
  type TaskCraftbookStep,
  normalizeStepGate,
  projectManagedWorkspaceWritable,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import { gateCheckLabel } from './gate-eval.js';
import type { StepGateOutcome } from './step-gate.js';

type WorkspacePolicyReader = Pick<Store, 'getProject' | 'readProjectWorkspaceFile'>;

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
export async function unsatisfiableStepWorkspaceFiles(
  store: WorkspacePolicyReader,
  projectId: string,
  task: Pick<Task, 'diffpackId'>,
  step: Pick<TaskCraftbookStep, 'advanceWhen' | 'gate'>,
): Promise<string[] | null> {
  // A drafting task's workspace writes are re-rooted into the diffpack
  // overlay, and its gates read through that overlay — the writes-off
  // policy cannot make its deliverable unwinnable. That is the point of
  // proposing on a locked workspace.
  if (task.diffpackId) return null;
  const project = await store.getProject(projectId).catch(() => null);
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
          (await store.readProjectWorkspaceFile(projectId, file).catch(() => null)) === null,
      ),
    );
    if (!missing.some(Boolean)) return null;
  }
  return [...files];
}

/**
 * A rejected gate is unsatisfiable when a FAILING check reads the
 * workspace tree while gezel workspace writes are off for the project.
 * Returns the workspace files the failing checks name (possibly empty),
 * or null when the gate is repairable. Drawer-only failures stay
 * repairable — the artifacts drawer is deliberately exempt from the
 * writes-off policy.
 *
 * A gate SCRIPT names no file, so it is judged by what the step itself
 * owes: unwinnable only when the step's own deliverable is a workspace
 * file nobody can write. Counting every script rejection as a
 * workspace-write failure misread the note-only gate on Pull Request
 * Review's scope step — the note was written correctly and the real
 * fault was elsewhere, but the task paused telling the user to enable
 * workspace writes, which would have changed nothing.
 */
export async function unsatisfiableWorkspaceGateFiles(
  store: WorkspacePolicyReader,
  projectId: string,
  task: Pick<Task, 'diffpackId'>,
  step: Pick<TaskCraftbookStep, 'advanceWhen' | 'gate'>,
  gate: NormalizedStepGate,
  outcome: StepGateOutcome,
): Promise<string[] | null> {
  // Drafting tasks: see unsatisfiableStepWorkspaceFiles — the overlay
  // makes workspace deliverables writable regardless of policy.
  if (task.diffpackId) return null;
  const project = await store.getProject(projectId).catch(() => null);
  if (!project || projectManagedWorkspaceWritable(project)) return null;
  const workspaceChecks = new Map<string, string | undefined>();
  for (const c of gate.checks) {
    // Read receipts are satisfied by reading existing artifacts, not by
    // changing the workspace. corpusReadEvidence may read its batch manifest
    // from the workspace, but that does not make a missing read a write.
    if (c.kind === 'artifactReadEvidence' || c.kind === 'corpusReadEvidence') continue;
    if ((c as { artifact?: boolean }).artifact === true) continue;
    workspaceChecks.set(gateCheckLabel(c), (c as { file?: string }).file);
  }
  const failingWorkspace = (outcome.checkResults ?? []).filter(
    (o) => !o.ok && workspaceChecks.has(o.label),
  );
  if (failingWorkspace.length > 0) {
    return [...new Set(failingWorkspace.map((o) => o.file).filter((f): f is string => !!f))];
  }
  if (!outcome.runs.some((r) => r.decision === 'reject')) return null;
  return await unsatisfiableStepWorkspaceFiles(store, projectId, task, step);
}

/**
 * True when EVERY one of `tasks` is parked on a step that owes a
 * workspace file managed writes can't produce. Lets the ambient nudger
 * tell a genuinely stuck writes-off project from one doing artifact-only
 * work — the drawer is exempt from the writes-off policy, so a nightly
 * report or a review still completes there and its voorman still wants
 * the check-in.
 *
 * Conservative by construction: an empty list, a task with no active
 * step, or any step whose deliverable is satisfiable all answer `false`.
 * We only claim "blocked" on positive evidence for every task.
 */
export async function allActiveStepsBlockedByWorkspaceWrites(
  store: WorkspacePolicyReader,
  projectId: string,
  tasks: readonly Task[],
): Promise<boolean> {
  if (tasks.length === 0) return false;
  for (const task of tasks) {
    const step = task.activeStepId
      ? task.craftbook.steps.find((s) => s.id === task.activeStepId)
      : undefined;
    if (!step) return false;
    if (!(await unsatisfiableStepWorkspaceFiles(store, projectId, task, step))) return false;
  }
  return true;
}
