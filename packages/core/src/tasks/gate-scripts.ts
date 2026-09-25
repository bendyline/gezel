/**
 * How a gate's scripts decide, on every host.
 *
 * Scripts run in declared order. The first rejection stops the chain with
 * its message and routing. Among approvals, the last script's `goto` and
 * `handoff` win, because later scripts in a list are by construction the
 * more specific ones. A script the host declined to run by policy is
 * skipped and reported, never blocking (fail-open). A script that cannot
 * run, fails, or returns something that is not a verdict is an
 * infrastructure fault: the task pauses without charging a deliverable
 * attempt, because rewriting the user's work cannot repair a broken gate.
 */
import { createLogger } from '../log.js';
import {
  type GateScriptRef,
  type GateScriptResult,
  GateScriptResultSchema,
} from '../schemas/gate.js';

const log = createLogger('tasks');

export interface GateScriptRunLike {
  id?: string;
  status: string;
  output?: unknown;
  error?: string;
  logs?: string;
}

/** How the host executes one gate script; policy decisions live there. */
export type GateScriptExecutor = (ref: GateScriptRef) => Promise<GateScriptRunLike | 'skipped'>;

export interface GateScriptTrail {
  scriptName: string;
  runId?: string;
  decision?: string;
  error?: string;
  /** Tail of the persisted script run log. */
  logsTail?: string;
}

export interface GateScriptsOutcome {
  decision: 'approve' | 'reject';
  /** Prescriptive guidance on reject. */
  message?: string;
  /** Explicit routing override stamped by a gate script. */
  goto?: string;
  /** Payload for the next step, stamped by an approving gate script. */
  handoff?: GateScriptResult['handoff'];
  /** Scripts skipped by policy (fail-open). */
  skipped: string[];
  /** Per-script trail for history and log lines. */
  runs: GateScriptTrail[];
  /** The gate itself could not execute; not evidence about the deliverable. */
  infrastructureError?: true;
}

/** The last stretch of a run log, for a diagnostic note. */
export function tailGateLogs(logs: string | undefined, maxChars = 2_000): string | undefined {
  const trimmed = logs?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed;
}

/**
 * Symbols a script author reliably reaches for from the wrong SDK subpath,
 * mapped to where they actually live. A message that says where the symbol
 * lives is the difference between a one-line correction and an abandoned run.
 */
const SDK_SYMBOL_HOMES: ReadonlyArray<{ symbols: readonly string[]; from: string }> = [
  { symbols: ['defineScript', 'gezel', 'InferredInput'], from: '@bendyline/gezel-sdk' },
  { symbols: ['gateResult', 'workspaceFromGezel'], from: '@bendyline/gezel-sdk/checks' },
];

/** Append the correct import when a script failed on a missing export we recognise. */
export function withSdkImportHint(error: string): string {
  const missing = /does not provide an export named ['"`]?([A-Za-z0-9_]+)/.exec(error);
  const symbol = missing?.[1];
  if (!symbol) return error;
  const home = SDK_SYMBOL_HOMES.find((entry) => entry.symbols.includes(symbol));
  if (!home) return error;
  return `${error} \`${symbol}\` is exported from "${home.from}" — import it from there. A gate script normally needs both: \`import { defineScript, gezel } from '@bendyline/gezel-sdk'\` and \`import { gateResult, workspaceFromGezel } from '@bendyline/gezel-sdk/checks'\`.`;
}

/** One line per script run, for the "gate unavailable" task note. */
export function formatGateScriptDiagnostics(runs: readonly GateScriptTrail[]): string {
  return runs
    .map(
      (run) =>
        `${run.scriptName}${run.runId ? ` (run ${run.runId})` : ''}: ${run.error ?? ''}${run.logsTail ? `\n${run.logsTail}` : ''}`,
    )
    .join('\n');
}

export async function evaluateGateScripts(
  refs: readonly GateScriptRef[],
  run: GateScriptExecutor,
  options: { steps?: ReadonlyArray<{ id: string }> } = {},
): Promise<GateScriptsOutcome> {
  const runs: GateScriptTrail[] = [];
  const skipped: string[] = [];
  const fault = (message: string): GateScriptsOutcome => ({
    decision: 'reject',
    message,
    infrastructureError: true,
    skipped,
    runs,
  });
  let goto: string | undefined;
  let handoff: GateScriptResult['handoff'];
  for (const ref of refs) {
    let result: GateScriptRunLike | 'skipped';
    try {
      result = await run(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runs.push({ scriptName: ref.name, error: message });
      return fault(
        `Gate script "${ref.name}" could not run: ${message}. Fix the gate configuration or ask the user for help.`,
      );
    }
    if (result === 'skipped') {
      skipped.push(ref.name);
      continue;
    }
    const logsTail = tailGateLogs(result.logs);
    if (result.status !== 'ok') {
      runs.push({
        scriptName: ref.name,
        ...(result.id ? { runId: result.id } : {}),
        error: result.error ?? 'failed',
        ...(logsTail ? { logsTail } : {}),
      });
      return fault(
        `Gate script "${ref.name}" failed: ${withSdkImportHint(result.error ?? 'unknown error')}.`,
      );
    }
    const parsed = GateScriptResultSchema.safeParse(result.output);
    if (!parsed.success) {
      runs.push({
        scriptName: ref.name,
        ...(result.id ? { runId: result.id } : {}),
        error: 'invalid gate result',
        ...(logsTail ? { logsTail } : {}),
      });
      return fault(
        `Gate script "${ref.name}" returned an invalid result (${parsed.error.issues[0]?.message ?? 'shape mismatch'}). A gate script must output { decision: 'approve' | 'reject', message, ... }.`,
      );
    }
    const verdict = parsed.data;
    if (
      verdict.goto !== undefined &&
      options.steps &&
      !options.steps.some((step) => step.id === verdict.goto)
    ) {
      // A route to a step the task does not declare is a craftbook bug the
      // assignee cannot repair; treating it as a rejection would charge them.
      runs.push({
        scriptName: ref.name,
        ...(result.id ? { runId: result.id } : {}),
        error: `Gate route "${verdict.goto}" is not a declared task step`,
      });
      return fault(`Gate route "${verdict.goto}" is not a declared task step`);
    }
    runs.push({
      scriptName: ref.name,
      ...(result.id ? { runId: result.id } : {}),
      decision: verdict.decision,
    });
    if (verdict.decision === 'reject') {
      return {
        decision: 'reject',
        message: verdict.message ?? 'Gate rejected the step.',
        ...(verdict.goto !== undefined ? { goto: verdict.goto } : {}),
        skipped,
        runs,
      };
    }
    if (verdict.goto !== undefined) goto = verdict.goto;
    if (verdict.handoff !== undefined) handoff = verdict.handoff;
  }
  if (skipped.length > 0)
    log.warn(`[gate] scripts skipped by policy: ${skipped.join(', ')} — approving (fail-open)`);
  return {
    decision: 'approve',
    ...(goto !== undefined ? { goto } : {}),
    ...(handoff !== undefined ? { handoff } : {}),
    skipped,
    runs,
  };
}
