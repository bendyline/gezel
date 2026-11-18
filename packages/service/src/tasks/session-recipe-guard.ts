/**
 * What a gezel's session may change in a task's recipe. The person's own
 * steps (review, approval, sign-off) are theirs, and once a task has started,
 * the checks and routing it started with are the bar its work is judged by.
 * A model under pressure that could edit either would approve its own work
 * or route around the gate it keeps failing, so a session may add to a
 * started recipe but not weaken it. First-party callers are not limited.
 */

import {
  type StepPatch,
  type Task,
  type TaskCraftbookStep,
  applyStepPatch,
  isOwnerStep,
  removeStepAndCleanEdges,
} from '@bendyline/gezel';

interface Recipe {
  steps: TaskCraftbookStep[];
  entryStepId: string;
}

/** The checks a step's work is held to. A session may add one, never change or drop it. */
const CHECK_FIELDS = ['gate', 'advanceWhen', 'toolPolicy'] as const;
/** Where a step leads. Changing it can route the work around a check or the person's step. */
const ROUTING_FIELDS = ['next', 'branches', 'terminal', 'runWhen'] as const;

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}

/** Why a session may not turn `current` into `next`, or null when it may. */
export function sessionRecipeRefusal(task: Task, next: Recipe): string | null {
  const current = task.craftbook;
  const nextById = new Map(next.steps.map((s) => [s.id, s]));
  const ownerSteps = current.steps.filter((s) => isOwnerStep(s));
  for (const step of ownerSteps) {
    const after = nextById.get(step.id);
    if (!after) return `"${step.name}" is the person's own step; a gezel cannot remove it.`;
    if (stable(after) !== stable(step)) {
      return `"${step.name}" is the person's own step; a gezel cannot change it.`;
    }
  }
  // A draft nobody started, with no step of the person's, is still being written.
  if (task.status === 'draft' && ownerSteps.length === 0) return null;

  if (next.entryStepId !== current.entryStepId) {
    return 'a started task keeps its first step; a gezel cannot change it.';
  }
  const kept = current.steps.filter((s) => nextById.has(s.id)).map((s) => s.id);
  const keptInNext = next.steps.filter((s) => kept.includes(s.id)).map((s) => s.id);
  if (kept.join('\n') !== keptInNext.join('\n')) {
    return 'a started task keeps the order of its steps; a gezel can add steps but not move them.';
  }
  for (const step of current.steps) {
    const after = nextById.get(step.id);
    if (!after) return `a started task keeps its steps; a gezel cannot remove "${step.name}".`;
    for (const field of ROUTING_FIELDS) {
      if (stable(after[field]) !== stable(step[field])) {
        return `a started task keeps where "${step.name}" leads; a gezel cannot change it.`;
      }
    }
    for (const field of CHECK_FIELDS) {
      if (step[field] !== undefined && stable(after[field]) !== stable(step[field])) {
        return `"${step.name}" keeps the checks it started with; a gezel can add a check but not change or remove one.`;
      }
    }
  }
  const currentIds = new Set(current.steps.map((s) => s.id));
  for (const step of next.steps) {
    if (currentIds.has(step.id)) continue;
    if (step.terminal || step.next !== undefined || (step.branches?.length ?? 0) > 0) {
      return `a step added to a started task follows the steps around it; "${step.name}" cannot end the task or jump elsewhere.`;
    }
  }
  return null;
}

export function stepPatchRefusal(task: Task, stepId: string, patch: StepPatch): string | null {
  const steps = task.craftbook.steps.map((s) => (s.id === stepId ? applyStepPatch(s, patch) : s));
  return sessionRecipeRefusal(task, { steps, entryStepId: task.craftbook.entryStepId });
}

export function stepRemovalRefusal(task: Task, stepId: string): string | null {
  if (!task.craftbook.steps.some((s) => s.id === stepId)) return null;
  let steps: TaskCraftbookStep[];
  try {
    steps = removeStepAndCleanEdges(task.craftbook.steps, stepId);
  } catch {
    return null;
  }
  return sessionRecipeRefusal(task, { steps, entryStepId: task.craftbook.entryStepId });
}

export function stepOrderRefusal(task: Task, order: string[]): string | null {
  const byId = new Map(task.craftbook.steps.map((s) => [s.id, s]));
  const steps = order.map((id) => byId.get(id)).filter((s): s is TaskCraftbookStep => Boolean(s));
  if (steps.length !== task.craftbook.steps.length) return null;
  return sessionRecipeRefusal(task, { steps, entryStepId: task.craftbook.entryStepId });
}
