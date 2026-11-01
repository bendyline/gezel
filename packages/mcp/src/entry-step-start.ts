import { type Task, isOwnerStep, stepOwnerGezelId } from '@bendyline/gezel';

export interface EntryStepStart {
  /** What happened to the task's first step, for the tool result. */
  text: string;
  /** False when nobody is working on it yet, so the reply must not say it is underway. */
  underway: boolean;
}

/**
 * What `invoke_craftbook` says about who starts the new task. It used to
 * report every entry step as "dispatched to the recipe-selected specialist".
 * A recipe whose steps name no role makes a task owned by the person, and
 * nothing starts it: gemma4-12b invoked its own supplier-intake recipe twice,
 * was told both times that the work was dispatched, and the tasks sat on
 * their first step until the trial ended (2026-10-31). Ownership comes from
 * core's `stepOwnerGezelId`, the rule entry dispatch itself applies.
 */
export function entryStepStart(task: Task): EntryStepStart {
  const step = task.craftbook.steps.find((candidate) => candidate.id === task.activeStepId);
  const dispatched: EntryStepStart = {
    text: `Active step ${task.activeStepId ?? '(none)'} was dispatched to the recipe-selected specialist.`,
    underway: true,
  };
  if (task.status !== 'active' || !step) return dispatched;
  if (isOwnerStep(step)) {
    return {
      text: `Its first step "${step.name}" is the person's own step, so it waits for them.`,
      underway: false,
    };
  }
  if (stepOwnerGezelId(task, step)) return dispatched;
  return {
    text: `Nobody was assigned to start its first step "${step.name}" (${step.id}): the step names no suggestedRole and the task belongs to the person, so it will sit idle. Assign it now with assign_task({ ref: "${task.ref}", assignee: "<a gezel's name or a role>" }), which starts the step. Do not invoke the recipe again. If you wrote this recipe, give each step a suggestedRole so the next run starts on its own.`,
    underway: false,
  };
}
