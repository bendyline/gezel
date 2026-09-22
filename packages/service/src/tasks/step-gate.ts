import {
  type GateScriptRef,
  GateScriptResultSchema,
  type NormalizedStepGate,
  type ScriptRun,
  createLogger,
  evaluateGateScripts,
  tailGateLogs,
  unresolvedGatePlaceholders,
  withSdkImportHint,
} from '@bendyline/gezel';

export { tailGateLogs, withSdkImportHint };
import {
  type GateCheckOutcome,
  type GateEvalDeps,
  type GateWorkspaceReader,
  evaluateGate,
} from './gate-eval.js';

const log = createLogger('tasks');

/**
 * ─ Step-gate evaluation engine ───────────────────────────────────────
 *
 * One engine for both gate moments (completion guard + legacy
 * activation evaluator). Aggregation contract:
 *
 *   1. Declarative `checks` run first, in-process, zero sandbox spawns.
 *      Any failure → immediate reject with the failure lines bulleted as
 *      the prescriptive message — the common "obviously not done" case
 *      never pays a script spawn.
 *   2. Gate `scripts` run in declared order through the sandbox runner.
 *      A script error or a result that doesn't parse as a GateScriptResult
 *      is fail-closed and marked as an INFRASTRUCTURE ERROR. The task manager
 *      pauses without charging a deliverable attempt: rewriting user work
 *      cannot repair a missing runtime or broken gate configuration.
 *      The first `reject` short-circuits with its message/goto. Among
 *      multiple approvals the LAST `goto`/`handoff` wins — later scripts
 *      in the list are by construction more specific.
 *   3. Scripts the caller skipped by policy (`'skipped'`) do not block
 *      approval — fail-open — but are reported so the caller can append
 *      a visible "gate scripts skipped" note. `standard`-scope scripts
 *      are never skipped (trusted, packed into the app); the caller
 *      enforces that distinction.
 */

export interface StepGateOutcome {
  decision: 'approve' | 'reject';
  /** Prescriptive guidance on reject; brief diagnostics on approve. */
  message?: string;
  /** Explicit routing override stamped by a gate script. */
  goto?: string;
  /** Payload for the next step, stamped by an approving gate script. */
  handoff?: { message: string; params?: Record<string, unknown> };
  /** Names of scripts skipped by security/engagement policy (fail-open). */
  skipped: string[];
  /** Per-script trail for history/log lines. */
  runs: Array<{
    scriptName: string;
    runId?: string;
    decision?: string;
    error?: string;
    /** Redacted tail of the persisted script run log. */
    logsTail?: string;
  }>;
  /**
   * The gate itself could not execute or returned an invalid protocol shape.
   * This is not evidence that the deliverable failed and must not feed the
   * repair/plateau ladder.
   */
  infrastructureError?: true;
  /**
   * Per-check structured outcomes from the declarative floor (pass AND
   * fail), when the gate ran checks. Verdict prose is derived from the
   * failing entries; plateau signatures hash their labels; gate telemetry
   * histograms their kinds. Absent for pure script gates.
   */
  checkResults?: GateCheckOutcome[];
}

/** How the caller executes one gate script (policy decisions live there). */
export type GateScriptExecutor = (ref: GateScriptRef) => Promise<ScriptRun | 'skipped'>;

export async function evaluateStepGate(opts: {
  gate: NormalizedStepGate;
  ws: GateWorkspaceReader;
  runScript: GateScriptExecutor;
  /** Injected capabilities for the spawning checks (`nodeRuns`). */
  deps?: GateEvalDeps;
  /** The task's declared steps; a gate route to any other step is a fault. */
  steps?: ReadonlyArray<{ id: string }>;
}): Promise<StepGateOutcome> {
  const { gate, ws, runScript, deps } = opts;
  const runs: StepGateOutcome['runs'] = [];
  const skipped: string[] = [];
  let checkResults: GateCheckOutcome[] | undefined;

  const unresolved = unresolvedGatePlaceholders(gate);
  if (unresolved.length > 0) {
    return {
      decision: 'reject',
      message: `Gate configuration error: ${unresolved.join(', ')} still contains an unresolved template placeholder, so this gate can never pass — it is checking a path or pattern that is the literal "{{…}}" text. Nothing you can do in this task will fix it. Do not write a file to the literal path and do not restate the token in a note: the gate rejects on configuration before any check runs, so neither is read, and both leave stray files behind. Stop here. A person has to correct the craftbook or its launch parameters and relaunch the task.`,
      infrastructureError: true,
      skipped,
      runs,
    };
  }

  if (gate.checks.length > 0) {
    const result = await evaluateGate(gate.checks, ws, deps);
    checkResults = result.checks;
    if (!result.pass) {
      // Cap the verdict at the first 6 failing bullets — it reaches small
      // local models verbatim, and a 15-bullet wall buries the fix. The
      // full set stays on checkResults for telemetry/diagnostics.
      const MAX_VERDICT_BULLETS = 6;
      const bullets = result.failures
        .slice(0, MAX_VERDICT_BULLETS)
        .map((f) => `- ${f}`)
        .join('\n');
      const overflow = result.failures.length - MAX_VERDICT_BULLETS;
      return {
        decision: 'reject',
        message: overflow > 0 ? `${bullets}\n- … and ${overflow} more failing checks` : bullets,
        skipped,
        runs,
        checkResults,
      };
    }
  }

  const scripts = await evaluateGateScripts(gate.scripts, runScript, {
    ...(opts.steps ? { steps: opts.steps } : {}),
  });
  return { ...scripts, ...(checkResults ? { checkResults } : {}) };
}

/** Stable fingerprint for rejection-nudge dedup (same text → same print). */
export function gateMessageFingerprint(message: string): string {
  // djb2 — tiny, stable, good enough for dedup keys.
  let h = 5381;
  for (let i = 0; i < message.length; i++) {
    h = ((h << 5) + h + message.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
