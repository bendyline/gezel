import {
  GATE_DEFAULT_MAX_ATTEMPTS,
  type GateCheck,
  type GateScriptRef,
  type NormalizedStepGate,
} from '@bendyline/gezel';
import type { GateCheckOutcome, GateWorkspaceReader } from '../tasks/gate-eval.js';
import {
  type GateScriptExecutor,
  evaluateStepGate,
  gateMessageFingerprint,
} from '../tasks/step-gate.js';

/**
 * ─ Ad-hoc deliverable contract ───────────────────────────────────────
 *
 * The completion contract a consultation/handoff deliverable must clear,
 * carried on `ExpectedDeliverable.{checks,scripts}`. It is evaluated with
 * the SAME engine a craftbook step's completion gate uses
 * (`evaluateStepGate`), so "what done means" is one codebase whether the
 * work is scripted (a craftbook step) or ad-hoc (one gezel asks another
 * for a file). Reuse, not a parallel evaluator — the only difference is
 * there's no task/step to attach attempts to, so this is a pure verdict.
 */

export interface DeliverableContract {
  checks?: GateCheck[];
  scripts?: GateScriptRef[];
}

export interface DeliverableContractVerdict {
  decision: 'approve' | 'reject';
  /** Prescriptive guidance on reject (the gate engine's message). */
  message?: string;
  /** Dedup key for the re-prompt nudge (stable per message). */
  fingerprint?: string;
  /** Per-check structured outcomes from the declarative floor. */
  checkResults?: GateCheckOutcome[];
}

/**
 * Evaluate a deliverable's contract. An empty contract approves trivially
 * (nothing to check). On reject the message is the gate engine's
 * prescriptive verdict, ready to feed the re-prompt loop.
 */
export async function evaluateDeliverableContract(opts: {
  contract: DeliverableContract;
  ws: GateWorkspaceReader;
  runScript: GateScriptExecutor;
  maxAttempts?: number;
}): Promise<DeliverableContractVerdict> {
  const checks = opts.contract.checks ?? [];
  const scripts = opts.contract.scripts ?? [];
  if (checks.length === 0 && scripts.length === 0) return { decision: 'approve' };

  const gate: NormalizedStepGate = {
    at: 'completion',
    checks,
    scripts,
    maxAttempts: opts.maxAttempts ?? GATE_DEFAULT_MAX_ATTEMPTS,
    legacy: false,
  };
  const outcome = await evaluateStepGate({ gate, ws: opts.ws, runScript: opts.runScript });
  if (outcome.decision === 'reject') {
    const message = outcome.message ?? 'Deliverable gate rejected.';
    return {
      decision: 'reject',
      message,
      fingerprint: gateMessageFingerprint(message),
      ...(outcome.checkResults ? { checkResults: outcome.checkResults } : {}),
    };
  }
  return {
    decision: 'approve',
    ...(outcome.checkResults ? { checkResults: outcome.checkResults } : {}),
  };
}
