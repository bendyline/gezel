/**
 * What a gate rejection costs, and where it sends the task.
 *
 * A rejection charges one attempt against the step's budget. An
 * infrastructure fault charges nothing and pauses, because fixing the
 * deliverable cannot repair a broken gate. A converging pass, one that
 * leaves fewer items outstanding than the last, spends the progress budget
 * instead of the attempt budget, so a large corpus is not capped by the
 * attempt limit. When the budget runs out the task pauses without routing.
 * A route back to the same step keeps its budget; a route elsewhere starts
 * that step fresh. Both hosts computed all of this separately, with one
 * defaulting the budget to three and the other to four.
 */
import { GATE_MAX_PROGRESS_ATTEMPTS } from '../schemas/gate.js';

export interface GateRejectionInput {
  step: { id: string; gateAttempts?: number; gateProgressAttempts?: number };
  gate: { maxAttempts: number; onReject?: string };
  verdict: { infrastructureError?: boolean; goto?: string; converging?: boolean };
  steps: ReadonlyArray<{ id: string }>;
}

export interface GateRejectionPlan {
  attempt: number;
  progressAttempts: number;
  maxAttempts: number;
  budgetExhausted: boolean;
  progressExhausted: boolean;
  paused: boolean;
  /** The step to activate next; absent when pausing or when the route is unknown. */
  routeTo?: string;
  preserveGateBudget: boolean;
  /** A route naming no declared step: a craftbook bug for the host to surface. */
  unknownRoute?: string;
}

export function applyGateRejection(input: GateRejectionInput): GateRejectionPlan {
  const prior = input.step.gateAttempts ?? 0;
  const priorProgress = input.step.gateProgressAttempts ?? 0;
  const maxAttempts = input.gate.maxAttempts;
  if (input.verdict.infrastructureError)
    return {
      attempt: prior,
      progressAttempts: priorProgress,
      maxAttempts,
      budgetExhausted: false,
      progressExhausted: false,
      paused: true,
      preserveGateBudget: false,
    };
  const converging = input.verdict.converging === true;
  const progressAttempts = converging ? priorProgress + 1 : priorProgress;
  const attempt = converging ? Math.max(prior, 1) : prior + 1;
  const progressExhausted = progressAttempts >= GATE_MAX_PROGRESS_ATTEMPTS;
  const budgetExhausted = attempt >= maxAttempts && !converging;
  const paused = budgetExhausted || progressExhausted;
  const candidate = input.verdict.goto ?? input.gate.onReject;
  const unknownRoute =
    candidate !== undefined && !input.steps.some((step) => step.id === candidate)
      ? candidate
      : undefined;
  const routeTo = paused || unknownRoute !== undefined ? undefined : candidate;
  return {
    attempt,
    progressAttempts,
    maxAttempts,
    budgetExhausted,
    progressExhausted,
    paused,
    ...(routeTo !== undefined ? { routeTo } : {}),
    preserveGateBudget: routeTo === input.step.id,
    ...(unknownRoute !== undefined ? { unknownRoute } : {}),
  };
}
