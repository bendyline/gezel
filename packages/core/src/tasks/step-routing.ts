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

/**
 * The step a caller's explicit jump names, if it names one. A blank jump, or
 * one a model wrapped in its own quotes (`next: ""`), means "whatever comes
 * next", as an omitted one does: an argument whose every value has a sane
 * default should not be able to fail.
 */
export function explicitStepJump(override: string | undefined): string | undefined {
  const id = override
    ?.trim()
    .replace(/^(["'`])(.*)\1$/, '$2')
    .trim();
  return id && id !== 'next' ? id : undefined;
}

export function resolveNextStep(input: StepRouteInput): StepRoute {
  const exists = (id: string) => input.steps.some((step) => step.id === id);
  const route = (to: string): StepRoute =>
    exists(to) ? { kind: 'advance', to } : { kind: 'invalid', to };
  const jump = explicitStepJump(input.override);
  if (jump !== undefined) return route(jump);
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

/**
 * What a model is told when it names a step its task does not have: the step
 * ids that exist. A bare "no such step" left small models resending the same
 * invented id (`plan_menu` for `plan`) until the turn died.
 */
export function unknownTaskStepText(
  field: 'next' | 'stepId',
  id: string,
  steps: ReadonlyArray<{ id: string; name?: string }>,
): string {
  const roster = steps.map((s) => (s.name ? `"${s.id}" (${s.name})` : `"${s.id}"`)).join(', ');
  return field === 'next'
    ? `This task has no step "${id}". Its steps are: ${roster}. Pass one of those ids as \`next\`, or omit \`next\` to advance to the following step in order.`
    : `This task has no step "${id}". Its steps are: ${roster}. Pass one of those ids as \`stepId\`.`;
}
