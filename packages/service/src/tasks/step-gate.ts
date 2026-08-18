import {
  type GateScriptRef,
  GateScriptResultSchema,
  type NormalizedStepGate,
  type ScriptRun,
  createLogger,
} from '@bendyline/gezel';
import {
  type GateCheckOutcome,
  type GateEvalDeps,
  type GateWorkspaceReader,
  evaluateGate,
} from './gate-eval.js';

const log = createLogger('tasks');

/** Same shape `interpolateStepsContext` substitutes, so this sees exactly what it left behind. */
const TEMPLATE_PLACEHOLDER = /\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g;

/**
 * Gate fields still carrying a `{{param}}` token at evaluation time.
 *
 * Launch interpolation deliberately leaves UNKNOWN placeholders intact so
 * a craftbook typo stays visible rather than silently blanking to an
 * empty string. Visible to a human reading the recipe — but the model on
 * the other end of the gate just sees a rejection it cannot satisfy,
 * because the literal `{{…}}` is being handed to a regex engine or a
 * path resolver. Pull Request Review shipped `PR\s*#{{number}}` that way:
 * the reviewer had written the note correctly, spent three attempts
 * re-deriving why a correct note kept failing, and finally "passed" the
 * gate by writing the raw template token into the task's audit trail.
 *
 * No assignee can repair this, so it is an infrastructure fault — it
 * pauses for a human instead of charging attempts and climbing the
 * repair ladder.
 */
function unresolvedGatePlaceholders(gate: NormalizedStepGate): string[] {
  const found: string[] = [];
  const scan = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const hits = value.match(TEMPLATE_PLACEHOLDER);
      if (hits) found.push(`${path} (${[...new Set(hits)].join(' ')})`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => scan(entry, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        scan(entry, `${path}.${key}`);
      }
    }
  };
  gate.checks.forEach((check, i) => scan(check, `checks[${i}] ${check.kind}`));
  gate.scripts.forEach((ref, i) => scan(ref.inputs, `scripts[${i}] ${ref.name} inputs`));
  return found;
}

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
}): Promise<StepGateOutcome> {
  const { gate, ws, runScript, deps } = opts;
  const runs: StepGateOutcome['runs'] = [];
  const skipped: string[] = [];
  let checkResults: GateCheckOutcome[] | undefined;

  const unresolved = unresolvedGatePlaceholders(gate);
  if (unresolved.length > 0) {
    return {
      decision: 'reject',
      message: `Gate configuration error: ${unresolved.join(', ')} still contains an unresolved template placeholder, so this gate can never pass. The craftbook references a launch parameter that was not supplied. Fix the craftbook or relaunch with that parameter — no deliverable can satisfy it.`,
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

  let goto: string | undefined;
  let handoff: StepGateOutcome['handoff'];
  for (const ref of gate.scripts) {
    let run: ScriptRun | 'skipped';
    try {
      run = await runScript(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runs.push({ scriptName: ref.name, error: message });
      return {
        decision: 'reject',
        message: `Gate script "${ref.name}" could not run: ${message}. Fix the gate configuration or ask the user for help.`,
        infrastructureError: true,
        skipped,
        runs,
        ...(checkResults ? { checkResults } : {}),
      };
    }
    if (run === 'skipped') {
      skipped.push(ref.name);
      continue;
    }
    if (run.status !== 'ok') {
      runs.push({
        scriptName: ref.name,
        runId: run.id,
        error: run.error ?? 'failed',
        ...(tailGateLogs(run.logs) ? { logsTail: tailGateLogs(run.logs) } : {}),
      });
      return {
        decision: 'reject',
        message: `Gate script "${ref.name}" failed: ${run.error ?? 'unknown error'}.`,
        infrastructureError: true,
        skipped,
        runs,
        ...(checkResults ? { checkResults } : {}),
      };
    }
    const parsed = GateScriptResultSchema.safeParse(run.output);
    if (!parsed.success) {
      runs.push({
        scriptName: ref.name,
        runId: run.id,
        error: 'invalid gate result',
        ...(tailGateLogs(run.logs) ? { logsTail: tailGateLogs(run.logs) } : {}),
      });
      return {
        decision: 'reject',
        message: `Gate script "${ref.name}" returned an invalid result (${parsed.error.issues[0]?.message ?? 'shape mismatch'}). A gate script must output { decision: 'approve' | 'reject', message, ... }.`,
        infrastructureError: true,
        skipped,
        runs,
        ...(checkResults ? { checkResults } : {}),
      };
    }
    const verdict = parsed.data;
    runs.push({ scriptName: ref.name, runId: run.id, decision: verdict.decision });
    if (verdict.decision === 'reject') {
      return {
        decision: 'reject',
        // The schema requires a message on reject.
        message: verdict.message ?? 'Gate rejected the step.',
        ...(verdict.goto !== undefined ? { goto: verdict.goto } : {}),
        skipped,
        runs,
        ...(checkResults ? { checkResults } : {}),
      };
    }
    if (verdict.goto !== undefined) goto = verdict.goto;
    if (verdict.handoff !== undefined) handoff = verdict.handoff;
  }

  if (skipped.length > 0) {
    log.warn(`[gate] scripts skipped by policy: ${skipped.join(', ')} — approving (fail-open)`);
  }
  return {
    decision: 'approve',
    ...(goto !== undefined ? { goto } : {}),
    ...(handoff !== undefined ? { handoff } : {}),
    skipped,
    runs,
    ...(checkResults ? { checkResults } : {}),
  };
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

function tailGateLogs(logs: string, maxChars = 2_000): string {
  const trimmed = logs.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…${trimmed.slice(trimmed.length - maxChars)}`;
}
