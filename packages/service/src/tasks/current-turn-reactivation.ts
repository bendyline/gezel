/**
 * Where a gate's fresh activation goes when the model turn that triggered the
 * gate is still running (TaskManager's current-turn reactivation hook). The
 * product service wires this; tests drive the same function so the wiring
 * they exercise is the one that ships.
 */
import type { CurrentTurnStepReactivatedHook } from './manager-hooks.js';
import { isOwnerStep } from './step-runtime.js';

type ReactivationContext = Parameters<CurrentTurnStepReactivatedHook>[0];

export interface CurrentTurnReactivationDeps {
  chat: {
    adoptStepActivation(args: {
      taskRef: string;
      stepId: string;
      previousActivationAt: string | undefined;
      activationAt: string;
    }): void;
  };
  runner: {
    adoptActiveDispatchActivation(args: {
      taskRef: string;
      stepId: string;
      gezelId: string;
      activationAt: string;
    }): boolean;
  };
}

export function followCurrentTurnReactivation(
  deps: CurrentTurnReactivationDeps,
  { task, newStep, gatedStep, previousActivationAt }: ReactivationContext,
): void {
  // Only a self-loop stays with this turn. A route to another step gets its
  // own dispatch, which binds its session. Adopting for it re-keyed whatever
  // earlier pass of that step the runner still tracked (a generalist owner's
  // one session stays busy, so those linger) to the new activation, and the
  // runner then dropped the step's real dispatch as a duplicate.
  if (newStep.id !== gatedStep.id || !newStep.lastActivatedAt) return;
  deps.chat.adoptStepActivation({
    taskRef: task.ref,
    stepId: newStep.id,
    previousActivationAt,
    activationAt: newStep.lastActivatedAt,
  });
  const gezelId = isOwnerStep(newStep)
    ? undefined
    : newStep.assignee?.kind === 'gezel'
      ? newStep.assignee.gezelId
      : newStep.suggestedGezelId;
  if (!gezelId) return;
  deps.runner.adoptActiveDispatchActivation({
    taskRef: task.ref,
    stepId: newStep.id,
    gezelId,
    activationAt: newStep.lastActivatedAt,
  });
}
