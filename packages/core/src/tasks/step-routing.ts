import type { ScriptOutputPredicate } from '../schemas/script.js';
/**
 * Which step a task moves to when one completes.
 *
 * The precedence is the same on every host: an explicit jump from the
 * caller, then a gate script's route, then the gate's declared approval
 * route, then a host's own auto-advance route, then a terminal flag, then a
 * branch predicate over the exit script's output, then the declared `next`,
 * then simply the following step. A last step with no `next` ends the book:
 * left to re-activate itself, a book once re-ran its final step three times
 * and the fan-out barrier never released.
 */
import { scriptBranchGoto } from '../scripts/predicates.js';

export interface RoutableStep {
  id: string;
  next?: string;
  terminal?: boolean;
  branches?: Array<{ when: ScriptOutputPredicate; goto: string }>;
}

export interface StepRouteInput {
  steps: ReadonlyArray<RoutableStep>;
  currentId: string;
  /** The caller's explicit jump; `'next'` means "whatever comes next". */
  override?: string;
  gateGoto?: string;
  gateOnApprove?: string;
  /** A host's auto-advance route, for hosts that fold it into completion. */
  advanceWhenGoto?: string;
  /** The exit script's output, for branch predicates. */
  branchOutput?: unknown;
}

export type StepRoute =
  | { kind: 'advance'; to: string }
  | { kind: 'terminate' }
  /** A route to a step the task does not declare: a craftbook bug, not a transition. */
  | { kind: 'invalid'; to: string };

export function resolveNextStep(input: StepRouteInput): StepRoute {
  const exists = (id: string) => input.steps.some((step) => step.id === id);
  const route = (to: string): StepRoute =>
    exists(to) ? { kind: 'advance', to } : { kind: 'invalid', to };
  if (input.override !== undefined && input.override !== 'next') return route(input.override);
  if (input.gateGoto !== undefined) return route(input.gateGoto);
  if (input.gateOnApprove !== undefined) return route(input.gateOnApprove);
  if (input.advanceWhenGoto !== undefined) return route(input.advanceWhenGoto);
  const index = input.steps.findIndex((step) => step.id === input.currentId);
  const current = input.steps[index];
  if (!current) return { kind: 'invalid', to: input.currentId };
  if (current.terminal) return { kind: 'terminate' };
  const branch = current.branches
    ? scriptBranchGoto(current.branches, input.branchOutput)
    : undefined;
  if (branch !== undefined) return route(branch);
  if (current.next !== undefined) return route(current.next);
  const following = input.steps[index + 1];
  return following ? { kind: 'advance', to: following.id } : { kind: 'terminate' };
}
