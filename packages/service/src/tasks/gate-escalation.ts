/**
 * Gate-plateau escalation: pure helpers deciding WHEN a repair loop has
 * stopped moving and WHAT to say next. The eval synthesis's
 * top cross-model failure is the "last-criterion plateau" — a model gets
 * N−1 of N checks green, then rewrites 3-5 times without ever touching
 * the named defect, while each rejection is deduped into silence. The
 * ladder replaces that silence with strategy changes:
 *
 *   stage 0 — normal rejection (the gate's own verdict).
 *   stage 1 — targeted-edit directive: smallest edit on the named check;
 *             do NOT recreate the file. (Counters the under-editor's
 *             rewrite storm and the frozen resubmitter equally.)
 *   stage 2 — full-rewrite directive: targeted edits aren't landing,
 *             replace the deliverable whole. Deliberately worded to trip
 *             the llama-cpp immediate-write turn mode (write_file-only
 *             surface, low temp, thinking off).
 *   stage 3 — stop: pause with the full attempt trail as diagnosis.
 *
 * The plateau signature hashes failing-check IDENTITY (GateCheckOutcome
 * labels), not prose and not content bytes: byte churn with an unmoved
 * failure set IS the plateau (the eval harness's retryLoopSniffKey
 * lesson), while clearing any single check changes the signature and
 * resets the ladder. Kill-switch: GEZEL_DISABLE_GATE_ESCALATION=1
 * restores the legacy quiet-damper behavior.
 */

import { createHash } from 'node:crypto';
import type { GateAttemptRecord } from '@bendyline/gezel';
import type { GateCheckOutcome } from './gate-eval.js';

export type EscalationStage = 0 | 1 | 2 | 3;

/** Trail cap — matches the schema comment on `gateAttemptHistory`. */
export const GATE_ATTEMPT_TRAIL_CAP = 8;

export function escalationDisabled(): boolean {
  return process.env.GEZEL_DISABLE_GATE_ESCALATION === '1';
}

/**
 * Hash of the failing-check identity set. Sorted so check order never
 * matters; `script:<name>` entries cover script-gate rejects (which
 * carry no failing declarative checks).
 */
export function gateFailureSignature(
  checkResults: readonly GateCheckOutcome[] | undefined,
  runs: readonly { scriptName: string; decision?: string; error?: string }[],
): string {
  const labels = (checkResults ?? []).filter((c) => !c.ok).map((c) => c.label);
  for (const run of runs) {
    if (run.decision === 'reject' || run.error) labels.push(`script:${run.scriptName}`);
  }
  const canonical = [...labels].sort().join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Trailing run length of `currentSignature` (including the attempt being
 * scored, which is NOT yet in the trail): 1 + consecutive matching
 * entries from the trail's tail. A signature change anywhere breaks the
 * run — the ladder resets the moment real progress shows.
 */
export function plateauScore(
  trail: readonly GateAttemptRecord[] | undefined,
  currentSignature: string,
): number {
  let score = 1;
  for (let i = (trail?.length ?? 0) - 1; i >= 0; i--) {
    if (trail![i]!.signatureHash !== currentSignature) break;
    score += 1;
  }
  return score;
}

export function stageForPlateau(score: number): EscalationStage {
  if (score >= 4) return 3;
  if (score === 3) return 2;
  if (score === 2) return 1;
  return 0;
}

/** Append with the rolling cap. Returns a new array; input untouched. */
export function appendGateAttempt(
  trail: readonly GateAttemptRecord[] | undefined,
  entry: GateAttemptRecord,
): GateAttemptRecord[] {
  const next = [...(trail ?? []), entry];
  return next.length > GATE_ATTEMPT_TRAIL_CAP ? next.slice(-GATE_ATTEMPT_TRAIL_CAP) : next;
}

/**
 * Which tree the deliverable lives in — decides which write tool the
 * stage directives name. A directive that demands `write_file` for a
 * drawer deliverable (or on a surface that has no workspace write tools
 * at all) sends the model chasing a tool it does not have; the molen
 * dependency-audit night shift burned its whole gate budget exactly
 * that way. Default 'workspace' keeps legacy call sites byte-stable.
 */
export type DeliverableSurface = 'workspace' | 'artifact';

/**
 * Stage 1 — smallest-targeted-edit directive. Ports the eval harness's
 * state-aware pre-trigger wording ("your file EXISTS but fails the
 * check; do NOT recreate it"). The GATE_TARGETED_EDIT marker MUST trip
 * the llama-cpp `isGateSurgicalEditTurn` mode (low-temp, patch-only
 * tool surface) and MUST NOT contain any immediate-write trigger phrase
 * or scenario-check header — this stage wants a surgical edit, not a
 * whole-file rewrite (both directions pinned by unit tests). The
 * artifact surface has no partial-edit tool, so its "targeted edit" is
 * a minimal rewrite through `write_artifact`.
 */
export function buildStageOneNudge(opts: {
  file?: string;
  failingBullets: string;
  frozen: boolean;
  surface?: DeliverableSurface;
}): string {
  const artifact = opts.surface === 'artifact';
  const fileRef = opts.file ? `\`${opts.file}\`` : 'the deliverable';
  const opener = opts.frozen
    ? 'Continue. You resubmitted the SAME deliverable and the gate rejected it again for the same reasons — resubmitting unchanged content cannot pass.'
    : 'Continue. Your last edits did not move the gate — the same checks fail after each attempt.';
  const fix = artifact
    ? 'Fix the FIRST failure above with the smallest change — read the artifact with read_artifact, correct only the section the check names, and save it back with write_artifact. Do NOT switch to a different file, do NOT re-read everything, and do NOT reply that you already finished.'
    : 'Fix the FIRST failure above with the smallest targeted edit — use replace_in_file on the exact section the check names. Do NOT recreate the file, do NOT re-read everything, and do NOT reply that you already finished.';
  return `GATE_TARGETED_EDIT: ${opener} The ${artifact ? 'artifact' : 'file'} ${fileRef} EXISTS but fails exactly these checks:

${opts.failingBullets}

${fix}`;
}

/**
 * Stage 2 — complete-rewrite directive. The workspace wording embeds two
 * verified llama-cpp immediate-write trigger phrases ("Do not end your
 * turn until `write_file`", "write_file({ path:") plus the
 * GATE_FULL_REWRITE marker (the eval TICTACTOE_FULL_REWRITE convention)
 * so the provider clamps the turn to a write_file-only surface with
 * thinking off. The artifact wording deliberately avoids both trigger
 * phrases — a write_file-only clamp on a drawer deliverable would strand
 * the turn — and names `write_artifact` instead.
 */
export function buildStageTwoNudge(opts: {
  file: string;
  failingBullets: string;
  repeats: number;
  surface?: DeliverableSurface;
}): string {
  const tool = opts.surface === 'artifact' ? 'write_artifact' : 'write_file';
  return `GATE_FULL_REWRITE: targeted edits have not cleared the gate after ${opts.repeats} attempts — replace the deliverable whole. Do not end your turn until \`${tool}\` has rewritten \`${opts.file}\` as one complete corrected version fixing every failure below:

${opts.failingBullets}

Call ${tool}({ path: "${opts.file}", content: <the complete corrected file> }) as your next tool call. No planning prose, no reads first, no partial appends.`;
}

/**
 * Stage 3 — the pause-for-help diagnosis. Carries the whole trail so
 * whoever resumes (the user, or a stronger model) starts with the
 * investigation already done instead of a bare "paused" status.
 */
export function buildPlateauDiagnosisNote(opts: {
  stepName: string;
  stepId: string;
  trail: readonly GateAttemptRecord[];
  lastMessage: string;
}): string {
  const trailLines = opts.trail
    .map((t) => {
      const time = t.at.slice(11, 16);
      const checks =
        t.failedChecks && t.failedChecks.length > 0 ? t.failedChecks.join(', ') : 'gate rejected';
      return `- attempt ${t.attempt} (${time}Z): failed ${checks}${t.frozen ? ' — content unchanged (frozen resubmit)' : ''}`;
    })
    .join('\n');
  return `# Gate plateau — paused for help

Step "${opts.stepName}" (${opts.stepId}) failed the same gate checks ${opts.trail.length} attempts in a row without progress:

${trailLines}

Last verdict:

${opts.lastMessage}

Re-assign the step, adjust the step or its gate, or fix the file by hand — then set the task active again.`;
}
