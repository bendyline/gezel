/**
 * Sniff-check feedback loop — sibling to [runtime-feedback.ts](./runtime-feedback.ts).
 *
 * Where runtime-feedback closes the gap for scenarios with Playwright
 * assertions (tictactoe, tankcombat), this module closes the same gap
 * for scenarios with sniff-only success criteria (petshop). The
 * matrix #7 petshop reproduced this gap exactly: model wrote a 6 KB
 * HTML with 4 of 5 sniff signals, missing `working-image` because the
 * `<img src>` referenced a path that didn't exist. No nudge mechanism
 * told the model "you're missing `working-image`" — the trial silently
 * polled until the 45-minute timeout while the model thought it was done.
 *
 * Fires when the success-check polls and finds:
 *   - An artifact exists (sniff was computed),
 *   - The sniff is `ok: false`,
 *   - AND either a `failReason` or a `missingRequiredSignals` list.
 *
 * Posts a from-Meester message naming the specific missing signal(s) +
 * the `failReason` verbatim. Dedups by `(filePath, sorted-missing-set,
 * failReason)` so the 5-second poll doesn't spam the same nudge.
 *
 * Why a sibling module instead of extending runtime-feedback.ts: the
 * two checks live at different layers of the success-check pipeline
 * (sniff runs first, runtime runs only after sniff passes) and have
 * different data shapes (SniffResult vs RuntimeReport). Keeping them
 * separate makes the call sites obvious and the dedup state simple.
 */

import { tmpdir } from 'node:os';
import {
  attachableDeliverable,
  describeSendFailure,
  isBinaryDocumentDeliverablePath,
  isPermanentHandoffError,
} from './handoff.ts';
import type { SniffResult } from './success-check.ts';
import type { EvalContext, EvalTerminalFailure } from './types.ts';

/**
 * Per-context cache of "we've already nudged about this exact sniff
 * failure" hashes. WeakMap-keyed for auto-cleanup on trial end.
 */
const nudgeMemory = new WeakMap<EvalContext, Set<string>>();
/** Permanent request-shape failures are deduped per target; retrying the same
 * rejected payload every five seconds only floods logs and cannot heal. */
const permanentNudgeFailureMemory = new WeakMap<EvalContext, Set<string>>();
const INFLIGHT_FEEDBACK_DEFER_MS = 4 * 60_000;
/**
 * Upper bound on deferring the TERMINAL (stage >= 3) handoff behind an
 * in-flight turn.
 *
 * Ordinary nudges defer for at most `INFLIGHT_FEEDBACK_DEFER_MS` so a
 * productive turn is not interrupted. The terminal handoff deliberately
 * defers longer — its message is the last thing the target will read, and
 * delivering it mid-stream risks it being lost — but it was unbounded, so
 * a target that never closed its turn held a DECIDED trial open until the
 * runner's hard ceiling.
 *
 * Wild-caught on the inaugural frontier run of the hard suites:
 * `craftbook-author-gate-script` exhausted its repair ladder at 28 minutes
 * and then deferred the terminal handoff for another 42 minutes of a single
 * unbroken turn, burning device time on an outcome that was already settled.
 * Past this bound the turn is not "about to finish" in any useful sense, so
 * deliver and let the runner settle.
 */
const INFLIGHT_TERMINAL_DEFER_MS = 15 * 60_000;
const FEEDBACK_DEFERRAL_LOG_INTERVAL_MS = 60_000;
const feedbackDeferralLogMemory = new WeakMap<EvalContext, Map<string, number>>();

/**
 * The success checker polls every five seconds, so a healthy long-running turn
 * can otherwise write the same deferral line dozens of times. Preserve the
 * first observation and a one-minute heartbeat without drowning the evidence
 * around actual sends, mutations, and terminal decisions.
 */
function logFeedbackDeferral(ctx: EvalContext, key: string, message: string): void {
  let perContext = feedbackDeferralLogMemory.get(ctx);
  if (!perContext) {
    perContext = new Map();
    feedbackDeferralLogMemory.set(ctx, perContext);
  }
  const now = Date.now();
  const lastLoggedAt = perContext.get(key);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < FEEDBACK_DEFERRAL_LOG_INTERVAL_MS) return;
  perContext.set(key, now);
  ctx.log(message);
}

/**
 * Escalation ladder state, keyed by COARSE failure signature (filePath +
 * missing signals + digit-blinded failReason — deliberately excluding
 * dedupeToken/repairDirective/sourceText so byte churn on the SAME
 * failure counts as a repeat instead of forging a fresh identity). The
 * harness twin of the product's gate-escalation ladder: a model that
 * keeps revising a file without moving the exact same check needs a
 * strategy CHANGE, not the same bullets again.
 */
interface SniffEscalationState {
  /** Distinct delivered-and-completed attempts on this frozen signature. */
  attempts: number;
  /** Exact hash + content fingerprint of the last observed revision. */
  lastRevisionKey: string;
  /**
   * A nudge for this signature actually landed since the last attempt
   * bump. The anti-inflation guard: undelivered feedback (in-flight
   * deferral, no reachable target) must not count as a failed attempt.
   */
  sentSinceLastCount: boolean;
  /**
   * Completed-mutation counter captured immediately before the last
   * delivered nudge. A later committed successful mutation turn advances
   * the attempt even when it rewrote byte-identical content.
   */
  pendingRepairAction?: {
    sessionId: string;
    gezelId: string;
    projectId?: string;
    completedMutationTurns: number;
  };
  /** Stage-3 suppression log emitted once. */
  suppressionLogged: boolean;
}
const escalationMemory = new WeakMap<EvalContext, Map<string, SniffEscalationState>>();

/**
 * Last successfully DELIVERED sniff nudge per trial, with its stage. The
 * runner's retry-loop guard reads this to grant one bounded plateau reset
 * per ladder rung — on slow local models a rung takes 2-4 min to deliver
 * (the target is perpetually mid-turn, wild-caught: 54 deferrals in one
 * trial), and without the grace the count-based watchdog kills the trial
 * while the intervention it would be judged by is still in the mail.
 */
const lastNudgeDelivery = new WeakMap<EvalContext, { at: number; stage: number }>();

/** Generic watchdog nudges must not stack on a scenario-specific repair that
 * has just landed. Two minutes is one bounded local-model response window. */
export const HARNESS_INTERVENTION_SETTLE_MS = 2 * 60_000;
const lastHarnessInterventionDelivery = new WeakMap<EvalContext, number>();

export function noteHarnessInterventionDelivered(ctx: EvalContext, at = Date.now()): void {
  lastHarnessInterventionDelivery.set(ctx, at);
}

export function lastDeliveredHarnessIntervention(ctx: EvalContext): number | null {
  return lastHarnessInterventionDelivery.get(ctx) ?? null;
}

export function lastDeliveredSniffNudge(ctx: EvalContext): { at: number; stage: number } | null {
  return lastNudgeDelivery.get(ctx) ?? null;
}

function ensureEscalationState(
  escalation: Map<string, SniffEscalationState>,
  key: string,
  revisionKey: string,
): SniffEscalationState {
  let state = escalation.get(key);
  if (!state) {
    state = {
      attempts: 1,
      lastRevisionKey: revisionKey,
      sentSinceLastCount: false,
      suppressionLogged: false,
    };
    escalation.set(key, state);
  }
  return state;
}

/**
 * Advance one escalation counter using the delivered-then-completed
 * discipline: a new revision (or a later committed successful mutation
 * turn) after a delivered nudge = one failed attempt. Shared verbatim by
 * the per-signature ladder and the score-plateau ladder so the
 * anti-inflation guarantees stay identical.
 */
async function advanceEscalationState(
  ctx: EvalContext,
  state: SniffEscalationState,
  revisionKey: string,
  filePath: string,
  ladder: 'signature' | 'plateau',
): Promise<void> {
  let completedPostNudgeRepair = false;
  if (state.sentSinceLastCount && state.pendingRepairAction && ctx.snapshotRepairActions) {
    const checkpoint = state.pendingRepairAction;
    try {
      const snapshot = await ctx.snapshotRepairActions({
        sessionId: checkpoint.sessionId,
        gezelId: checkpoint.gezelId,
        ...(checkpoint.projectId ? { projectId: checkpoint.projectId } : {}),
      });
      completedPostNudgeRepair =
        snapshot !== null &&
        !snapshot.inflight &&
        snapshot.completedMutationTurns > checkpoint.completedMutationTurns;
    } catch (err) {
      ctx.log(
        `[sniff-feedback] completed repair-action check failed for ${checkpoint.gezelId}/${checkpoint.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const revisionChanged = revisionKey !== state.lastRevisionKey;
  if ((revisionChanged || completedPostNudgeRepair) && state.sentSinceLastCount) {
    state.attempts += 1;
    state.sentSinceLastCount = false;
    state.lastRevisionKey = revisionKey;
    state.pendingRepairAction = undefined;
    if (completedPostNudgeRepair) {
      ctx.log(
        `[sniff-feedback] counted completed post-nudge file mutation for ${filePath}${revisionChanged ? ' alongside a checked-content revision' : ' despite byte-identical checked content'} (${ladder} attempt ${state.attempts})`,
      );
    }
  } else if (revisionChanged) {
    state.lastRevisionKey = revisionKey;
  }
}

/**
 * Cheap content fingerprint (fnv-1a over the first 4 KB + length) — the
 * revision detector for the escalation counter and a ready-made
 * `dedupeToken` for scenarios whose failReason can persist across
 * materially different revisions (data-wrangle's one-golden-miss shape).
 */
export function contentRevisionToken(text: string): string {
  let hash = 0x811c9dc5;
  const window = text.slice(0, 4096);
  for (let i = 0; i < window.length; i++) {
    hash ^= window.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(36)}-${text.length}`;
}

/** Digit-blind a failReason so numeric churn (byte counts, row counts) reads as the SAME failure. */
function normalizeFailReasonForSignature(failReason: string): string {
  return failReason.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

function coarseSniffSignature(filePath: string, sniff: SniffResult): string {
  const missing = blindVolatileTempPaths(
    (sniff.missingRequiredSignals ?? []).slice().sort().join(','),
  );
  const failReason = normalizeFailReasonForSignature(
    blindVolatileTempPaths(sniff.failReason ?? ''),
  );
  return `${filePath}::missing:${missing}::fail:${failReason}`;
}

/** Mirror of the product ladder's stageForPlateau: 2→targeted-edit, 3→full-rewrite, ≥4→suppress. */
export function stageForSniffAttempts(attempts: number): 0 | 1 | 2 | 3 {
  if (attempts >= 4) return 3;
  if (attempts === 3) return 2;
  if (attempts === 2) return 1;
  return 0;
}

/**
 * Score-plateau ladder — one notch later than the signature ladder.
 *
 * The signature ladder counts repeats of one frozen failure; it is blind
 * to the PROGRESSIVE shape, where every completed repair fixes the named
 * detail only for a different check to surface (failReason class and even
 * the checked file keep moving) while the scenario score never rises.
 * Wild-caught as qwen3.5-9b × schema-migration 0/5: store.ts → migrate.ts
 * → handlers.ts, a fresh signature each time, attempts never reached 2,
 * and the harness retry-loop killed the trial before any escalation fired.
 * Later thresholds are deliberate: a model grinding through subcontracts
 * is making a kind of progress the frozen ladder never sees, so it earns
 * more runway before the terminal rung.
 */
export function stageForSniffPlateau(attempts: number): 0 | 1 | 2 | 3 {
  if (attempts >= 6) return 3;
  if (attempts >= 4) return 2;
  if (attempts === 3) return 1;
  return 0;
}

export interface SniffFeedbackOptions {
  /**
   * `<img src>` values known to resolve from the failing HTML file to
   * an image file in the project. These are already relative to the HTML
   * file, not project-root paths.
   */
  availableImageSrcs?: string[];
  /**
   * `<img src>` values currently in the failing HTML file that resolve
   * to missing local image files. These are the exact search strings a
   * repair nudge can hand to `replace_in_file`.
   */
  brokenImageSrcs?: string[];
  /**
   * Scenario-specific repair instruction. Use sparingly when the generic
   * sniff guidance cannot name the exact mechanical fix.
   */
  repairDirective?: string;
  /**
   * Optional scenario-provided revision key. Use when the same failing
   * signal/failReason can persist across multiple materially different
   * deliverable revisions and each new revision should receive feedback.
   */
  dedupeToken?: string;
  /**
   * Optional project id used for target selection and coordinator copies.
   */
  projectId?: string;
  /**
   * Pin feedback to a known gezel, such as the author of a task-native
   * deliverable. When omitted, feedback uses the usual role/recency picker.
   */
  targetGezelId?: string;
  /**
   * Current contents of the failing deliverable. Used for exact parse-
   * repair hints and as one escalation-attempt signal, but deliberately
   * excluded from the per-stage send dedupe. Long tool-use turns can
   * partially rewrite files across polls; queuing the same stale nudge
   * for every partial revision buries the next real failure after the
   * model responds. Callers that truly need a distinct nudge within one
   * escalation stage should pass `dedupeToken`.
   */
  sourceText?: string;
  /**
   * Also send a copy to the Meester. Use for coordination-sensitive
   * multimodal scenarios where the direct implementer may be in a long
   * turn and unable to consume the repair nudge promptly.
   */
  notifyMeester?: boolean;
  /**
   * Defaults to the failing `filePath`, which enables direct file-write
   * repair mode for source deliverables. Set to `null` for failures that
   * need a non-write_file tool first, such as reading authoritative sources
   * or generating a missing image asset before patching HTML.
   */
  expectedDeliverable?: { kind: 'file'; filePath: string } | null;
  /**
   * Keep the handoff free of an eager `expectedDeliverable` write contract,
   * but name the only file that may be mutated after the repair directive's
   * prerequisite reads complete. This is for evidence-grounded repairs where
   * the model must read authoritative sources before it may patch or rewrite
   * the checked file.
   */
  postReadMutationTarget?: string;
  /**
   * Optional direct specialist handoff for sniff failures whose next
   * repair is a sibling asset rather than the failing source file.
   */
  assetHandoff?: {
    jobTitle: string;
    filePath: string;
    message: string;
  };
  /**
   * Override the default wait before posting feedback to a target that is
   * already mid-turn. Use this for scenarios with tight retry-loop windows
   * where a delayed repair nudge leaves too little room for the model to act.
   */
  inflightDeferMs?: number;
  /**
   * Keep all bounded escalation attempts on surgical file edits. Use when
   * the checker has proved the deliverable body already passes and a whole-
   * file rewrite would only put correct behavior at risk. Stage 3 still
   * suppresses after the same number of completed misses.
   */
  targetedEditsOnly?: boolean;
}

export type SniffFeedbackResult =
  | { status: 'no-op' | 'deduped' | 'deferred' | 'unroutable' | 'send-failed' }
  | { status: 'sent'; stage: 0 | 1 | 2; attempts: number }
  | { status: 'exhausted'; attempts: number; failure: EvalTerminalFailure };

function exhaustedSniffFeedbackFailure(
  filePath: string,
  sniff: SniffResult,
  attempts: number,
): EvalTerminalFailure {
  const missing = (sniff.missingRequiredSignals ?? []).join(', ');
  const failure = sniff.failReason?.replace(/\s+/g, ' ').trim().slice(0, 700);
  const check = missing
    ? `missing signals stayed unchanged: ${missing}`
    : 'the same scenario failure stayed unchanged';
  return {
    reason: [
      `repair-exhausted: bounded scenario feedback exhausted after ${attempts} delivered-and-completed attempts on ${filePath}; ${check}.`,
      failure ? `Last failure: ${failure}` : '',
    ]
      .filter(Boolean)
      .join(' '),
    failureMode: 'model-stuck',
  };
}

/**
 * Blind throwaway temp-directory paths before they reach a ladder key.
 *
 * A failure that embeds a fresh `mkdtemp` root every evaluation is the
 * SAME failure, but it hashes differently each poll, which resets the
 * per-signature escalation counter forever and inflates the score-plateau
 * counter by one "completed repair" per five-second poll. Only tmpdir-
 * rooted paths are blinded: a real workspace path in a failure genuinely
 * distinguishes one failure from another and must keep hashing apart.
 */
function blindVolatileTempPaths(text: string): string {
  const temp = tmpdir().replace(/[/\\]+$/, '');
  if (!temp) return text;
  const escaped = temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:file://)?(?:/private)?${escaped}[^\\s'"\`]*`, 'g');
  return text.replace(pattern, '<tmp>');
}

function hashSniffFailure(
  filePath: string,
  sniff: SniffResult,
  opts: SniffFeedbackOptions = {},
): string {
  const missing = blindVolatileTempPaths(
    (sniff.missingRequiredSignals ?? []).slice().sort().join(','),
  );
  const failReason = blindVolatileTempPaths(sniff.failReason ?? '');
  const imageSrcs = (opts.availableImageSrcs ?? []).slice().sort().join(',');
  const brokenImageSrcs = (opts.brokenImageSrcs ?? []).slice().sort().join(',');
  const repairDirective = opts.repairDirective ?? '';
  const dedupeToken = opts.dedupeToken ?? '';
  const expectedDeliverable =
    opts.expectedDeliverable === undefined
      ? 'default'
      : opts.expectedDeliverable === null
        ? 'none'
        : `${opts.expectedDeliverable.kind}:${opts.expectedDeliverable.filePath}`;
  const postReadMutationTarget = opts.postReadMutationTarget ?? '';
  const targetGezelId = opts.targetGezelId ?? '';
  const targetedEditsOnly = opts.targetedEditsOnly ? 'yes' : 'no';
  const assetHandoff = opts.assetHandoff
    ? `${opts.assetHandoff.jobTitle}:${opts.assetHandoff.filePath}:${opts.assetHandoff.message}`
    : '';
  const sourceRevision = '';
  return `${filePath}::missing:${missing}::failReason:${failReason}::imageSrcs:${imageSrcs}::brokenImageSrcs:${brokenImageSrcs}::repair:${repairDirective}::dedupe:${dedupeToken}::expected:${expectedDeliverable}::postReadMutationTarget:${postReadMutationTarget}::target:${targetGezelId}::targeted:${targetedEditsOnly}::asset:${assetHandoff}::source:${sourceRevision}`;
}

/**
 * When a sniff rejects an artifact, post a from-Meester message to the
 * most recently-active non-meester chat session naming the specific
 * signals the model is missing. No-op when:
 *
 *   - The sniff is already `ok: true` (success path is the caller's
 *     job, not ours).
 *   - Neither `missingRequiredSignals` nor `failReason` is set (nothing
 *     concrete to nudge with — sniff disagreed without saying why).
 *   - We've already posted a nudge for this exact failure fingerprint
 *     since the trial started (dedup).
 *   - No non-meester session is active yet.
 */
export async function postSniffFeedback(
  ctx: EvalContext,
  filePath: string,
  sniff: SniffResult,
  opts: SniffFeedbackOptions = {},
): Promise<SniffFeedbackResult> {
  if (sniff.ok) return { status: 'no-op' };
  const hasMissing = sniff.missingRequiredSignals && sniff.missingRequiredSignals.length > 0;
  const hasFailReason = !!sniff.failReason;
  if (!hasMissing && !hasFailReason) return { status: 'no-op' };

  let posted = nudgeMemory.get(ctx);
  if (!posted) {
    posted = new Set();
    nudgeMemory.set(ctx, posted);
  }
  const exactKey = hashSniffFailure(filePath, sniff, opts);

  // Escalation ladder: count DELIVERED-then-completed repeats of the same
  // coarse failure signature. A new revision (content fingerprint or any
  // exact-hash input changed), OR a later committed successful file-
  // mutation turn, after a delivered nudge = one failed attempt. The
  // latter catches a byte-identical rewrite that content alone cannot see.
  // The coarse signature ignores tokens/directives so churn counts as a
  // repeat, while any signal clearing or failReason class change starts a
  // fresh ladder.
  let escalation = escalationMemory.get(ctx);
  if (!escalation) {
    escalation = new Map();
    escalationMemory.set(ctx, escalation);
  }
  const coarseKey = coarseSniffSignature(filePath, sniff);
  const revisionKey = `${exactKey}::rev:${contentRevisionToken(opts.sourceText ?? '')}`;
  const state = ensureEscalationState(escalation, coarseKey, revisionKey);
  await advanceEscalationState(ctx, state, revisionKey, filePath, 'signature');

  // Scenario-level score-plateau counter. Keyed on the score alone — the
  // one thing stable across a progressive failure — so churn in the
  // failReason, the missing-signal set, or even the checked file itself
  // still accumulates. Any score improvement lands on a new key, which IS
  // the reset. Score 0 stays the hard-progress watchdog's territory.
  const plateauKey =
    typeof sniff.score === 'number' && sniff.score > 0 ? `__plateau__::score:${sniff.score}` : null;
  let plateauState: SniffEscalationState | undefined;
  if (plateauKey) {
    plateauState = ensureEscalationState(escalation, plateauKey, revisionKey);
    await advanceEscalationState(ctx, plateauState, revisionKey, filePath, 'plateau');
  }
  // A write_file clamp is the wrong order when the fix needs a non-write
  // tool first. Plain expectedDeliverable-null flows stay surgical; an
  // explicit post-read mutation target gets its own read-then-mutate
  // escalation. Do not cap the LOGICAL ladder at stage 1: reusing its
  // already-posted dedupe key would make attempt 4 and the bounded
  // exhaustion terminal unreachable.
  const signatureStage = stageForSniffAttempts(state.attempts);
  const plateauStage = plateauState ? stageForSniffPlateau(plateauState.attempts) : 0;
  // The plateau ladder only ever RAISES the stage — a frozen signature
  // repeating is always at least as damning as a churning one.
  const plateauDriven = plateauStage > signatureStage;
  const stage = plateauDriven ? plateauStage : signatureStage;
  const stagedAttempts = plateauDriven ? plateauState!.attempts : state.attempts;
  const drivingState = plateauDriven ? plateauState! : state;

  // Stage transitions re-key the binary dedup so the escalated message
  // actually sends even when every other hash input is frozen; identical
  // repeats WITHIN a stage still dedup.
  const key = `${exactKey}::stage:${stage}`;
  if (stage < 3 && posted.has(key)) return { status: 'deduped' };

  let target: TargetGezel | null = null;
  try {
    target = await pickTargetGezel(ctx, filePath, {
      projectId: opts.projectId,
      targetGezelId: opts.targetGezelId,
    });
  } catch (err) {
    ctx.log(
      `[sniff-feedback] target lookup failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const deliveryProjectId = opts.projectId ?? target?.projectId;
  const inflight = target ? await targetInflightTurn(ctx, target, deliveryProjectId) : null;
  const inflightFeedbackDeferMs = opts.inflightDeferMs ?? INFLIGHT_FEEDBACK_DEFER_MS;
  // The terminal handoff waits longer than an ordinary nudge, but not
  // forever — see INFLIGHT_TERMINAL_DEFER_MS.
  const deferCeilingMs = stage >= 3 ? INFLIGHT_TERMINAL_DEFER_MS : inflightFeedbackDeferMs;
  if (inflight && inflight.elapsedMs < deferCeilingMs) {
    logFeedbackDeferral(
      ctx,
      `sniff:${filePath}:${target?.gezelId ?? 'unknown'}:${deliveryProjectId ?? 'default'}:${stage >= 3 ? 'exhaustion' : 'nudge'}`,
      `[sniff-feedback] deferred ${stage >= 3 ? 'exhaustion terminal handoff' : 'nudge'} for ${filePath}; target ${target?.gezelId} is still mid-turn for ${Math.round(inflight.elapsedMs / 1000)}s${deliveryProjectId ? ` in project ${deliveryProjectId}` : ''}`,
    );
    return { status: 'deferred' };
  }

  if (stage >= 3) {
    const failure = plateauDriven
      ? plateauExhaustedFailure(filePath, sniff, stagedAttempts)
      : exhaustedSniffFeedbackFailure(filePath, sniff, stagedAttempts);
    if (!drivingState.suppressionLogged) {
      drivingState.suppressionLogged = true;
      ctx.log(
        `[sniff-feedback] escalation stage 3${plateauDriven ? ' (score plateau)' : ''} for ${filePath} (${(sniff.missingRequiredSignals ?? []).join(',') || sniff.failReason}): suppressing further model nudges after ${stagedAttempts} completed misses and requesting terminal failure`,
      );
    }
    ctx.requestTerminalFailure?.(failure);
    return { status: 'exhausted', attempts: stagedAttempts, failure };
  }

  if (!target) {
    ctx.log(`[sniff-feedback] no non-meester session active yet; skipping nudge for ${filePath}`);
    return { status: 'unroutable' };
  }

  let permanentFailures = permanentNudgeFailureMemory.get(ctx);
  if (!permanentFailures) {
    permanentFailures = new Set();
    permanentNudgeFailureMemory.set(ctx, permanentFailures);
  }
  const permanentFailureKey = `${key}::target:${target.gezelId}`;
  if (permanentFailures.has(permanentFailureKey)) return { status: 'deduped' };

  const appendOnlyRepair = hasAppendOnlyRepairDirective(opts.repairDirective);
  const combinedRepair = hasCombinedRepairDirective(opts.repairDirective);
  const postReadMutationRepair = !!opts.postReadMutationTarget;
  const structuralRewriteRepair =
    structuralOrderRepairLine(filePath, sniff.failReason) !== undefined;
  const repeatLine = plateauDriven
    ? sniffPlateauEscalationLine(filePath, sniff, stagedAttempts)
    : sniffEscalationLine(filePath, sniff, stagedAttempts);
  const text =
    appendOnlyRepair && stage > 0
      ? `${sniffAppendEscalationLine(filePath, sniff, stagedAttempts)}\n\n${formatNudge(filePath, sniff, opts)}`
      : combinedRepair && stage > 0
        ? `${sniffCombinedEscalationLine(filePath, sniff, stagedAttempts)}\n\n${formatNudge(filePath, sniff, opts)}`
        : postReadMutationRepair && stage > 0
          ? `${sniffPostReadMutationEscalationLine(
              opts.postReadMutationTarget!,
              sniff,
              stagedAttempts,
              structuralRewriteRepair,
            )}\n\n${formatNudge(filePath, sniff, opts)}`
          : stage === 2
            ? opts.targetedEditsOnly || opts.expectedDeliverable === null
              ? `${repeatLine}\n\n${formatNudge(filePath, sniff, opts)}`
              : plateauDriven
                ? `${repeatLine}\n\n${formatFullRewriteNudge(filePath, sniff, opts, stagedAttempts)}`
                : formatFullRewriteNudge(filePath, sniff, opts, stagedAttempts)
            : stage === 1
              ? `${repeatLine}\n\n${formatNudge(filePath, sniff, opts)}`
              : formatNudge(filePath, sniff, opts);
  const expectedDeliverable =
    opts.expectedDeliverable === undefined
      ? { kind: 'file' as const, filePath }
      : opts.expectedDeliverable;
  const deliverableFragment = expectedDeliverable
    ? attachableDeliverable(expectedDeliverable.filePath, target.role, ctx.log)
    : {};
  let repairActionBaseline: Awaited<ReturnType<NonNullable<EvalContext['snapshotRepairActions']>>> =
    null;
  if (target.sessionId && ctx.snapshotRepairActions) {
    try {
      repairActionBaseline = await ctx.snapshotRepairActions({
        sessionId: target.sessionId,
        gezelId: target.gezelId,
        ...(deliveryProjectId ? { projectId: deliveryProjectId } : {}),
      });
    } catch (err) {
      ctx.log(
        `[sniff-feedback] repair-action baseline failed for ${target.gezelId}/${target.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    const delivered = await ctx.client.messageGezel(target.gezelId, {
      fileTurnIntent: {
        kind: 'repair-file',
        path: filePath,
        ...(opts.postReadMutationTarget ? { mutationPath: opts.postReadMutationTarget } : {}),
      },
      fromGezelId: ctx.meesterId,
      text,
      suppressReply: true,
      ...deliverableFragment,
      ...(deliveryProjectId ? { projectId: deliveryProjectId } : {}),
    });
    if (opts.notifyMeester) {
      await ctx.client.sendChatMessage(ctx.meesterId, {
        message: [formatCoordinatorCopy(filePath, opts), '', text].join('\n'),
        ...((opts.projectId ?? target.projectId)
          ? { projectId: opts.projectId ?? target.projectId }
          : {}),
      });
    }
    if (opts.assetHandoff) {
      const ensured = await ctx.client.ensureGezel({
        jobTitle: opts.assetHandoff.jobTitle,
      });
      await ctx.client.messageGezel(ensured.gezelId, {
        fromGezelId: ctx.meesterId,
        text: opts.assetHandoff.message,
        suppressReply: true,
        ...attachableDeliverable(opts.assetHandoff.filePath, ensured.role ?? 'Developer', ctx.log),
        ...(deliveryProjectId ? { projectId: deliveryProjectId } : {}),
      });
      ctx.log(
        `[sniff-feedback] handed off asset ${opts.assetHandoff.filePath} to ${ensured.gezelId} for ${filePath}`,
      );
    }
    posted.add(key);
    lastNudgeDelivery.set(ctx, { at: Date.now(), stage });
    noteHarnessInterventionDelivered(ctx);
    // A delivered nudge arms BOTH ladders' delivered-then-completed
    // counters — the plateau must keep counting across signature churn.
    const armedStates = plateauState ? [state, plateauState] : [state];
    for (const s of armedStates) {
      s.sentSinceLastCount = true;
      s.pendingRepairAction = undefined;
    }
    if (ctx.snapshotRepairActions) {
      const deliveredSessionId = delivered.sessionId ?? target.sessionId;
      const existingSessionWasIdle =
        target.sessionId !== undefined &&
        repairActionBaseline !== null &&
        !repairActionBaseline.inflight;
      const newlyCreatedSession = target.sessionId === undefined && !!deliveredSessionId;
      if (deliveredSessionId && (existingSessionWasIdle || newlyCreatedSession)) {
        for (const s of armedStates) {
          s.pendingRepairAction = {
            sessionId: deliveredSessionId,
            gezelId: target.gezelId,
            ...(deliveryProjectId ? { projectId: deliveryProjectId } : {}),
            completedMutationTurns: repairActionBaseline?.completedMutationTurns ?? 0,
          };
        }
      }
    }
    ctx.log(
      `[sniff-feedback] nudged ${target.gezelId} about ${filePath} sniff failure${stage > 0 ? ` (escalation stage ${stage}${plateauDriven ? ' via score plateau' : ''}, attempt ${stagedAttempts})` : ''}: ` +
        `missing=[${(sniff.missingRequiredSignals ?? []).join(', ')}]${sniff.failReason ? ` failReason="${sniff.failReason}"` : ''}`,
    );
    return { status: 'sent', stage: stage as 0 | 1 | 2, attempts: stagedAttempts };
  } catch (err) {
    const msg = describeSendFailure(err);
    if (isPermanentHandoffError(err)) {
      permanentFailures.add(permanentFailureKey);
      ctx.log(
        `[sniff-feedback] suppressing identical repair sends to ${target.gezelId} after permanent client error`,
      );
    }
    ctx.log(`[sniff-feedback] messageGezel failed for ${target.gezelId}: ${msg}`);
    return { status: 'send-failed' };
  }
}

/**
 * Stage-1 prepend: name the repeat and demand a targeted edit. MUST NOT
 * contain any llama-cpp immediate-write trigger phrase — this stage wants
 * a surgical patch, not a rewrite (the provider's repair modes reinforce
 * the same direction).
 */
/**
 * Plateau-stage prepend: the failing DETAIL keeps moving but the score
 * does not — symptom-at-a-time patching from memory. Distinct teaching
 * from the frozen-signature line: demand a fresh read plus one whole-
 * deliverable sweep against the scenario's requirements, not another
 * chase of the newest named check.
 */
function sniffPlateauEscalationLine(
  filePath: string,
  sniff: SniffResult,
  attempts: number,
): string {
  const score = typeof sniff.score === 'number' ? sniff.score : 0;
  return `SCORE PLATEAU — ${attempts} completed repairs and the scenario score is still ${score}. Each repair fixed the previously named detail only for a DIFFERENT check to fail; you are patching symptoms one at a time from memory. First re-read \`${filePath}\` with your file-read tool (\`read_file({ path: ${JSON.stringify(filePath)} })\`, or your built-in \`Read\` when \`read_file\` is not in your tool list) to see the current content, then re-read the scenario prompt and mission objectives, and fix EVERY remaining gap in \`${filePath}\` in one pass — not just the failure named below.`;
}

/** Terminal reason for a plateau-driven exhaustion — names the shape honestly. */
function plateauExhaustedFailure(
  filePath: string,
  sniff: SniffResult,
  attempts: number,
): EvalTerminalFailure {
  const score = typeof sniff.score === 'number' ? sniff.score : 0;
  const failure = sniff.failReason?.replace(/\s+/g, ' ').trim().slice(0, 700);
  return {
    reason: [
      `repair-exhausted (score plateau): ${attempts} completed repairs with the scenario score frozen at ${score} while the failing detail kept changing; latest checked file ${filePath}.`,
      failure ? `Last failure: ${failure}` : '',
    ]
      .filter(Boolean)
      .join(' '),
    failureMode: 'model-stuck',
  };
}

function sniffEscalationLine(filePath: string, sniff: SniffResult, attempts: number): string {
  const missing = (sniff.missingRequiredSignals ?? []).join(', ');
  // The fresh-read requirement is load-bearing: a completed repair that
  // left the same check failing means the model's mental copy of the file
  // is wrong somewhere — it patched the wrong spot, or the edit didn't
  // land the way it believes. Wild-caught on qwen3.5-9b × schema-migration
  // (0/5): three rewrites of the checked file without sniff movement, each
  // patching from memory of a file that no longer said what it thought.
  return `REPEAT MISS — attempt ${attempts} on \`${filePath}\`: your completed repair left the exact same check failing${missing ? ` (${missing})` : ''}. Your last edit did not change what the check reads, so your mental copy of this file is stale — first re-read it with your file-read tool (\`read_file({ path: ${JSON.stringify(filePath)} })\`, or your built-in \`Read\` when \`read_file\` is not in your tool list) and find the exact section the failure below names in the CURRENT content. Do not rewrite the whole file and do not reply that it is done. Then make the smallest targeted edit that fixes the FIRST failure named below, using \`replace_in_file\` or \`replace_lines\` on the exact section the check names.`;
}

function hasAppendOnlyRepairDirective(directive: string | undefined): boolean {
  const text = directive?.trim() ?? '';
  // Legacy camelCase spellings kept so pre-rename directives still match.
  return (
    /\bnext\s+tool\s+call\s+must\s+be\s+`?(?:append_to_file|appendToFile)\b/i.test(text) &&
    /\bdo\s+not\s+call\s+`?(?:write_file|writeFile)\b/i.test(text)
  );
}

function hasCombinedRepairDirective(directive: string | undefined): boolean {
  const text = directive?.trim() ?? '';
  return (
    /\bCOMBINED PATCH\b/i.test(text) &&
    /\bfix every acceptance failure\b/i.test(text) &&
    /\bcomplete every numbered file edit\b/i.test(text)
  );
}

function sniffAppendEscalationLine(filePath: string, sniff: SniffResult, attempts: number): string {
  const missing = (sniff.missingRequiredSignals ?? []).join(', ');
  return `REPEAT APPEND MISS — attempt ${attempts} on \`${filePath}\`: the previous append did not clear the same check${missing ? ` (${missing})` : ''}. Keep the existing passing content and follow the append_to_file directive below again with enough substantive headroom. Do not rewrite or replace the file, and do not reply that it is done.`;
}

function sniffCombinedEscalationLine(
  filePath: string,
  sniff: SniffResult,
  attempts: number,
): string {
  const missing = (sniff.missingRequiredSignals ?? []).join(', ');
  return `REPEAT COMBINED MISS — attempt ${attempts} on \`${filePath}\`: the previous multi-defect repair did not clear the same checks${missing ? ` (${missing})` : ''}. Preserve passing content and repeat the entire numbered repair directive below in this turn; do not stop after the first failure, rewrite the whole file, or reply that it is done.`;
}

function sniffPostReadMutationEscalationLine(
  mutationTarget: string,
  sniff: SniffResult,
  attempts: number,
  structuralRewrite: boolean,
): string {
  const missing = (sniff.missingRequiredSignals ?? []).join(', ');
  const mutationInstruction = structuralRewrite
    ? `repeat the bounded \`write_file\` rewrite of exactly \`${mutationTarget}\``
    : `use \`write_file\`, \`replace_in_file\`, or \`replace_lines\` on exactly \`${mutationTarget}\` as the failure requires`;
  return `REPEAT READ-THEN-MUTATE MISS — attempt ${attempts} on \`${mutationTarget}\`: the previous grounded repair did not clear the same check${missing ? ` (${missing})` : ''}. Complete every required \`read_file\` call first, then ${mutationInstruction}. Do not mutate a similarly named path or reply that it is done.`;
}

/**
 * Stage-2 message: the strategy change to ONE complete rewrite. Contract
 * with the service side (providers/llama-cpp/provider.ts:301-332): the
 * two literal trigger phrases ("Do not end your turn until `write_file`"
 * and "write_file({ path:") land the immediate-write clamp (write_file-only
 * surface, temp 0.2, thinking off) — and the standard `[scenario check] I
 * looked at` header must NOT appear, because that header routes the turn
 * into the patch-only scenario-repair mode which actively FORBIDS
 * whole-file rewrites. Per-branch surgical coaching is deliberately
 * dropped: it was delivered twice and did not land; the scenario
 * repairDirective rides along as the spec body.
 */
function formatFullRewriteNudge(
  filePath: string,
  sniff: SniffResult,
  opts: SniffFeedbackOptions,
  attempts: number,
): string {
  const fired =
    (sniff.signals ?? []).length > 0
      ? `Signals that fired: ${(sniff.signals ?? []).join(', ')}.`
      : '';
  const missing =
    (sniff.missingRequiredSignals ?? []).length > 0
      ? `Signals that did NOT fire: **${(sniff.missingRequiredSignals ?? []).join(', ')}**.`
      : '';
  const failReason = sniff.failReason ? `Specific failure: ${sniff.failReason}` : '';
  const directive = opts.repairDirective?.trim() ?? '';
  return [
    `GATE_FULL_REWRITE: ${attempts} completed repairs of \`${filePath}\` have failed this scenario check with the exact same result — targeted edits are not landing. Replace the deliverable whole.`,
    [fired, missing, failReason].filter(Boolean).join('\n'),
    directive,
    `Do not end your turn until \`write_file\` has rewritten \`${filePath}\` as one complete corrected version that fixes every failure above. Call write_file({ path: "${filePath}", content: <the complete corrected file> }) as your next tool call. No planning prose, no reads first, no partial appends.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function formatCoordinatorCopy(filePath: string, opts: SniffFeedbackOptions): string {
  if (opts.expectedDeliverable === null && opts.postReadMutationTarget) {
    return `[scenario coordinator copy] The direct implementer may be in a long turn. This repair must read its authoritative sources first and then mutate exactly \`${opts.postReadMutationTarget}\`. If you take it over, complete the required \`read_file\` calls before using \`write_file\`, \`replace_in_file\`, or \`replace_lines\` on that exact path. Do not write a similarly named file, only write a task note, queue a plain message, or call ask_specialist for this repair.`;
  }
  if (opts.expectedDeliverable === null) {
    return `[scenario coordinator copy] The direct implementer may be in a long turn. This repair likely needs a non-write_file tool before the HTML patch. If you are coordinating this project and \`generate_image\` is available, generate the missing asset now (for petshop, save it as \`assets/logo.png\`), then patch \`${filePath}\` to reference it. If you need a handoff, ensure an Image Generator for \`assets/logo.png\` first, then a Builder/Developer for \`${filePath}\`. Do not only write a task note, queue a plain message, or call ask_specialist for this file.`;
  }
  return `[scenario coordinator copy] The direct implementer may be in a long turn. If you are coordinating this project, patch the workspace file yourself now or use a file handoff: ensure a Builder/Developer gezel, then call message_gezel with expectedDeliverable: { kind: "file", filePath: "${filePath}" }. Do not only write a task note, queue a plain message, or call ask_specialist for this file.`;
}

/**
 * Render the sniff failure into a message the model can act on. Names
 * both the signals that DID fire (so the model knows what's working)
 * and the ones that didn't (so it can target those specifically).
 * Includes the `failReason` verbatim when present.
 */
function formatNudge(
  filePath: string,
  sniff: SniffResult,
  opts: SniffFeedbackOptions = {},
): string {
  const passedLine =
    sniff.signals.length > 0
      ? `Signals that fired: ${sniff.signals.join(', ')}.`
      : 'No sniff signals fired yet.';
  const missingLine =
    sniff.missingRequiredSignals && sniff.missingRequiredSignals.length > 0
      ? `Signals that didn't fire: **${sniff.missingRequiredSignals.join('**, **')}**.`
      : '';
  const failReasonLine = sniff.failReason ? `Specific failure: ${sniff.failReason}` : '';
  const imageSrcs = uniqueNonEmpty(opts.availableImageSrcs).slice(0, 5);
  const brokenImageSrcs = uniqueNonEmpty(opts.brokenImageSrcs).slice(0, 8);
  const brokenImageExamples = [
    'assets/logo.png',
    'assets/placeholder-food.png',
    'assets/placeholder-toy.png',
    'assets/placeholder-bed.png',
    'assets/placeholder-shop.png',
    'assets/placeholder_logo.png',
    'assets/pet_placeholder.jpg',
    'assets/dog_food.jpg',
    'assets/cat_toy.jpg',
    'assets/fish_tank.jpg',
  ]
    .map((src) => `\`${src}\``)
    .join(', ');
  const brokenSrcList =
    brokenImageSrcs.length > 0
      ? brokenImageSrcs.map((src) => `\`${src}\``).join(', ')
      : `made-up paths like ${brokenImageExamples}, and artifact-only paths`;
  const firstBrokenSrc = brokenImageSrcs[0] ?? 'assets/dog_food.jpg';
  const exactReplaceCall =
    imageSrcs.length > 0
      ? `replace_in_file({ path: ${JSON.stringify(filePath)}, find: ${JSON.stringify(firstBrokenSrc)}, replace: ${JSON.stringify(imageSrcs[0])} })`
      : undefined;
  const missingSignals = sniff.missingRequiredSignals ?? [];
  const workingImageRepair =
    imageSrcs.length > 0
      ? `DO NOT call \`generate_image\` again: a real image asset already exists. EXACT PATCH: use the real workspace image src \`${imageSrcs[0]}\`. Broken image src values currently in \`${filePath}\`: ${brokenSrcList}. Replace those broken local image src values with \`${imageSrcs[0]}\`. Do not call \`make_dir\` for these paths, do not create empty asset directories, and do not create or reference \`assets/logo.png\` unless you actually write a real image file at that exact path; empty folders do not count. A valid logo tag for this file is \`<img src="${imageSrcs[0]}" alt="Pet shop logo">\`. If using a targeted patch, call \`${exactReplaceCall}\`, then repeat for each remaining broken image src, or use one \`write_file\` for the corrected HTML. It is enough for the signal to make at least one visible \`<img>\` resolve to the real workspace file, but replacing all broken image src values is better. Other valid image src value(s) for this HTML file: ${imageSrcs.map((src) => `\`${src}\``).join(', ')}. The missing \`working-image\` signal requires a real \`<img>\` element whose \`src\` resolves from this HTML file to an image file that exists in the workspace. Placeholder comments, CSS-only backgrounds, broken image filenames, make_dir-only fixes, and chat descriptions do not count. If your tool list includes \`replace_in_file\` or \`write_file\`, your next message must start with that tool call. If you do not have workspace write access, use a blocking file handoff: \`ensure_gezel\` for a Builder/Developer, then \`message_gezel\` with \`expectedDeliverable: { kind: "file", filePath: "${filePath}" }\` and include this exact fix; do not queue a message, call \`ask_specialist\`, or reply in prose.`
      : missingSignals.includes('image-asset')
        ? `No usable raster image asset exists in the project yet, so the missing \`working-image\` signal cannot be fixed by changing HTML alone. Create or generate a real workspace PNG/JPG/WebP/GIF image asset first, then reference it from \`${filePath}\`. Fast path: if \`generate_image\` is available, call \`generate_image({ prompt: "friendly pet shop logo, paw print, warm colors", saveAs: "assets/logo.png" })\`, then patch the HTML to \`<img src="assets/logo.png" alt="Pet shop logo">\`. Do not hand-write an SVG fallback, do not paste base64, and do not use CSS-only drawings; this scenario asks for an AI-generated logo image. \`make_dir\` alone is not enough; the check needs an actual raster image file and a matching \`<img src>\`. Placeholder comments, CSS-only backgrounds, external URLs, chat descriptions, and made-up filenames do not count. If your tool list includes \`generate_image\`, \`write_file\`, or \`replace_in_file\`, your next message must start with one of those tool calls. If you do not have workspace write access, use a blocking file handoff: \`ensure_gezel\` for an image-generator, then \`message_gezel\` with \`expectedDeliverable: { kind: "file", filePath: "assets/logo.png" }\`; after the image exists, have a Builder/Developer patch \`${filePath}\`. Do not queue a message, call \`ask_specialist\`, or reply in prose.`
        : `The missing \`working-image\` signal is concrete: the HTML must contain a real \`<img>\` element whose \`src\` resolves from this HTML file to an image file that exists in the workspace. The page already has an image asset, so connect it now. If \`assets/logo.png\` exists beside this page, patch the placeholder with \`<img src="assets/logo.png" alt="Pet shop logo">\`. Placeholder comments like \`<!-- Placeholder for logo.png -->\`, CSS-only backgrounds, artifact-only paths, and chat descriptions do not count. If your tool list includes \`replace_in_file\` or \`write_file\`, your next message must start with that tool call. If you do not have workspace write access, use a blocking file handoff: \`ensure_gezel\` for a Builder/Developer, then \`message_gezel\` with \`expectedDeliverable: { kind: "file", filePath: "${filePath}" }\`; do not queue a message, call \`ask_specialist\`, or reply in prose.`;
  const customRepair = opts.repairDirective?.trim();
  const parseRepair = isSourceParseFailure(sniff)
    ? sourceParseRepairLine(filePath, sniff.failReason, opts.sourceText)
    : undefined;
  const structuralOrderRepair = structuralOrderRepairLine(filePath, sniff.failReason);
  const postReadMutationLine = opts.postReadMutationTarget
    ? `POST_READ_MUTATION_TARGET: complete the required \`read_file\` calls first. After the final required read succeeds, mutate exactly \`${opts.postReadMutationTarget}\` with the named \`write_file\` or patch operation; do not write a similarly named path.`
    : undefined;
  const repairLine = parseRepair
    ? [parseRepair, customRepair].filter(Boolean).join(' ')
    : structuralOrderRepair
      ? [structuralOrderRepair, customRepair].filter(Boolean).join(' ')
      : customRepair
        ? customRepair
        : isTicTacToeRewriteFailure(sniff)
          ? ticTacToeFullRewriteLine(filePath)
          : isHtmlSizeFailure(sniff)
            ? `This is a source-file quality miss, not a one-line patch. Replace \`${filePath}\` with one complete, more substantive version using \`write_file\`; target roughly 5-7 KB of real HTML/CSS/JS. Add actual gameplay/app behavior such as HUD details, health/lives, enemy behavior, collisions, restart/game-over state, or visual effects. Do not pad with comments or repeated no-op code. Do not use \`write_artifact\` for HTML/source deliverables; use workspace \`write_file\` with the path relative to the workspace root. Your next assistant action should be that \`write_file\` call, or if you lack workspace write access, make a blocking handoff to a Builder/Developer with \`expectedDeliverable: { kind: "file", filePath: "${filePath}" }\`.`
            : isWorkingImageFailure(sniff)
              ? workingImageRepair
              : [
                  'The artifact exists but the trial-level checker is waiting for the missing signals above.',
                  'Re-read the scenario prompt + mission objectives, identify what each missing signal is testing for, and patch the deliverable.',
                  'If this is a small edit, use `replace_in_file` or `replace_lines`; otherwise use `write_file` to re-emit the checked file.',
                  `Your next assistant action should be a file-writing tool call for \`${filePath}\`, not a prose summary saying it is fixed.`,
                  'If a signal name is unclear (e.g. `working-image` means an `<img src>` that actually resolves to a real file in the workspace — not just any `<img>` tag), think about what would make the page actually function the way the user asked for it.',
                ].join(' ');

  return [
    `[scenario check] I looked at \`${filePath}\` and the success criteria aren't met yet.`,
    passedLine,
    missingLine,
    failReasonLine,
    '',
    postReadMutationLine,
    repairLine,
  ]
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}

export function structuralOrderRepairLine(
  filePath: string,
  failReason: string | undefined,
): string | undefined {
  if (
    !/\b(?:execution order|out of order|must (?:come|appear|be) (?:before|after)|(?:before|after) its own .*heading)\b/i.test(
      failReason ?? '',
    )
  ) {
    return undefined;
  }
  return [
    'This is a structural-order failure, not missing-content feedback.',
    `Read \`${filePath}\` once, then use one bounded \`write_file\` rewrite that places the existing sections/steps in the required order.`,
    'Do not append another copy of the value or heading; remove duplicates and preserve already-correct observed values.',
  ].join(' ');
}

function ticTacToeFullRewriteLine(filePath: string): string {
  return [
    'TICTACTOE_FULL_REWRITE: this is not a planning or polish issue; the tic-tac-toe page still lacks the concrete game structure or substantive game logic the checker can run.',
    `Your next tool call MUST be \`write_file\` for \`${filePath}\`; do not call \`validate\`, \`read_file\`, \`ask_user_question\`, create another project, or delegate again before writing.`,
    `Replace \`${filePath}\` with one complete self-contained HTML document. Include these exact mechanical pieces: a visible title containing "Tic Tac Toe"; a status element for "X's turn" / "O's turn"; nine literal clickable \`button\` elements in the HTML with \`class="cell"\` and \`data-cell\` indexes 0-8; \`const winningLines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];\`; \`cells.forEach((cell) => cell.addEventListener("click", handleClick))\`; win and draw detection that sets \`gameOver\`; draw detection; winning-cell highlighting; score counters for X/O/draws; and a Reset / Play Again button wired to clear the board.`,
    'The inline script must be substantive, about 1-2 KB of real state and functions. Do not pad with comments, repeated no-op code, or unused variables.',
    `Use this compact structure if you are unsure what to write: ${TICTACTOE_COPYABLE_HTML}`,
    'Do not append another script fragment or narrate success. Re-emit one clean full file with real CSS/HTML/JS, no external dependencies, and no JavaScript-created placeholder board.',
  ].join(' ');
}

const TICTACTOE_COPYABLE_HTML = [
  '`<!doctype html><html><head><meta charset="utf-8"><title>Tic Tac Toe</title>',
  '<style>body{font-family:sans-serif;text-align:center}#board{display:grid;grid-template-columns:repeat(3,90px);gap:8px;justify-content:center}.cell{width:90px;height:90px;font-size:48px}.win{background:#9fd}#status{margin:16px;font-weight:bold}</style>',
  '</head><body><h1>Tic Tac Toe</h1><div id="status">X turn</div>',
  '<div id="board"><button class="cell" data-cell="0"></button><button class="cell" data-cell="1"></button><button class="cell" data-cell="2"></button><button class="cell" data-cell="3"></button><button class="cell" data-cell="4"></button><button class="cell" data-cell="5"></button><button class="cell" data-cell="6"></button><button class="cell" data-cell="7"></button><button class="cell" data-cell="8"></button></div>',
  '<button id="reset">Reset / Play Again</button><script>',
  'var cells=Array.from(document.querySelectorAll(".cell"));var statusEl=document.getElementById("status");var resetBtn=document.getElementById("reset");var winningLines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];var board=Array(9).fill("");var currentPlayer="X";var gameOver=false;',
  'function showTurn(){if(!gameOver){statusEl.textContent=currentPlayer+" turn"}}function checkWinner(){for(var n=0;n<winningLines.length;n++){var line=winningLines[n];var a=line[0];var b=line[1];var c=line[2];if(board[a]!==""&&board[a]===board[b]&&board[a]===board[c]){cells[a].classList.add("win");cells[b].classList.add("win");cells[c].classList.add("win");return board[a]}}return ""}',
  'function handleClick(){var index=Number(this.getAttribute("data-cell"));if(gameOver||board[index]!==""){return}board[index]=currentPlayer;this.textContent=currentPlayer;var win=checkWinner();if(win!==""){gameOver=true;statusEl.textContent=win+" wins!";return}if(board.every(function(value){return value!==""})){gameOver=true;statusEl.textContent="Draw game";return}currentPlayer=currentPlayer==="X"?"O":"X";showTurn()}',
  'function resetGame(){board=Array(9).fill("");currentPlayer="X";gameOver=false;for(var i=0;i<cells.length;i++){cells[i].textContent="";cells[i].classList.remove("win")}showTurn()}cells.forEach(function(cell){cell.addEventListener("click",handleClick)});resetBtn.addEventListener("click",resetGame);showTurn();',
  '</script></body></html>`',
].join('');

function uniqueNonEmpty(values: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function sourceParseRepairLine(
  filePath: string,
  failReason: string | undefined,
  sourceText: string | undefined,
): string {
  if (isTruncatedHtmlScriptFailure(failReason)) {
    return [
      'Because this is a truncated inline `<script>` block, finish or replace the file without adding duplicate script fragments.',
      `First read \`${filePath}\`. If the file still ends inside the current script, use \`append_to_file\` with only the missing tail: close any open string/block, finish the current app logic, then include \`</script></body></html>\`.`,
      'The append content must NOT start a new `<script>` tag, must NOT include placeholder text like `Hello` or `...`, and must NOT repeat the already-written declarations.',
      `If you cannot confidently continue from the exact cutoff, call \`write_file\` once with a shorter complete version of \`${filePath}\` that preserves the signals already firing, includes one parseable inline script, and has all closing tags.`,
    ].join(' ');
  }
  if (isDuplicateDeclarationFailure(failReason)) {
    return [
      'Because this parse failure is a duplicate declaration, do not insert another copy of the same function, variable, test block, or verification block.',
      `Read \`${filePath}\` once, then either remove every duplicated block with a targeted edit or replace \`${filePath}\` with one clean complete file using \`write_file\`.`,
      'Keep exactly one declaration for the named identifier and exactly one copy of the surrounding test/feature block.',
      'Do not use `append_to_file`, `insert_at_marker`, or `replace_lines` to add more declarations while repairing this failure.',
    ].join(' ');
  }
  const exactRepairs = sourceText ? sourceParseRepairHints(filePath, sourceText) : [];
  const exactRepairLine =
    exactRepairs.length > 0
      ? `Exact patch candidate(s): ${exactRepairs.join(' ; ')}. If one matches the file you read, call it before a full rewrite.`
      : 'If the parser error names an exact character, duplicate declaration, stray quote, or extra parenthesis, use one exact `replace_in_file` call for that text before attempting a full rewrite.';
  return [
    'Because this is a source parse failure in an existing file, patch the deliverable with the smallest syntax fix first.',
    `Read \`${filePath}\`, then use \`replace_in_file\` for exact bad text before trying a full \`write_file\`.`,
    'Whole-file `write_file` overwrites are validated and can be refused if the re-emitted HTML still has a parse error.',
    exactRepairLine,
    'Do not use `append_to_file` or `insert_at_marker` to add duplicate top-level declarations, classes, or functions while repairing parse errors.',
  ].join(' ');
}

function isTruncatedHtmlScriptFailure(failReason: string | undefined): boolean {
  return /<script> opened|script block is unterminated|no <\/script>|truncated mid-script|unexpected end of input/i.test(
    failReason ?? '',
  );
}

function isDuplicateDeclarationFailure(failReason: string | undefined): boolean {
  return /Identifier ['"][^'"]+['"] has already been declared|already been declared/i.test(
    failReason ?? '',
  );
}

function sourceParseRepairHints(filePath: string, sourceText: string): string[] {
  const candidates: Array<{ find: string; replace: string; occurrence?: 'all' }> = [
    { find: "background: #353';", replace: 'background: #353;' },
    { find: "background:#353';", replace: 'background:#353;' },
    { find: 'requestAnimationFrame(draw));', replace: 'requestAnimationFrame(draw);' },
    { find: 'requestAnimationFrame(gameLoop));', replace: 'requestAnimationFrame(gameLoop);' },
    { find: 'requestAnimationFrame(update));', replace: 'requestAnimationFrame(update);' },
    { find: 'tx.fillStyle', replace: 'ctx.fillStyle', occurrence: 'all' },
    { find: 'tx.fillRect', replace: 'ctx.fillRect', occurrence: 'all' },
    { find: 'tx.clearRect', replace: 'ctx.clearRect', occurrence: 'all' },
    { find: 'board[combo[0]]]', replace: 'board[combo[0]]', occurrence: 'all' },
    { find: 'board[combo[1]]]', replace: 'board[combo[1]]', occurrence: 'all' },
    { find: 'board[combo[2]]]', replace: 'board[combo[2]]', occurrence: 'all' },
    { find: 'board[condition[0]]]', replace: 'board[condition[0]]', occurrence: 'all' },
    { find: 'board[condition[1]]]', replace: 'board[condition[1]]', occurrence: 'all' },
    { find: 'board[condition[2]]]', replace: 'board[condition[2]]', occurrence: 'all' },
    { find: 'board[b]]', replace: 'board[b]', occurrence: 'all' },
    { find: 'board[c]]', replace: 'board[c]', occurrence: 'all' },
  ];
  return candidates
    .filter((candidate) => sourceText.includes(candidate.find))
    .slice(0, 4)
    .map((candidate) =>
      formatReplaceInFileCall(filePath, candidate.find, candidate.replace, candidate.occurrence),
    );
}

function formatReplaceInFileCall(
  filePath: string,
  find: string,
  replace: string,
  occurrence?: 'all',
): string {
  const occurrenceArg = occurrence ? `, occurrence: ${JSON.stringify(occurrence)}` : '';
  return `replace_in_file({ path: ${JSON.stringify(filePath)}, find: ${JSON.stringify(find)}, replace: ${JSON.stringify(replace)}${occurrenceArg} })`;
}

function isSourceParseFailure(sniff: SniffResult): boolean {
  const reason = sniff.failReason ?? '';
  return (
    /does not parse|failed to parse|syntax error|unexpected token|unterminated|already been declared/i.test(
      reason,
    ) || (sniff.missingRequiredSignals ?? []).some((signal) => /parses/i.test(signal))
  );
}

function isWorkingImageFailure(sniff: SniffResult): boolean {
  return (sniff.missingRequiredSignals ?? []).includes('working-image');
}

function isHtmlSizeFailure(sniff: SniffResult): boolean {
  return (sniff.missingRequiredSignals ?? []).includes('html-size-ok');
}

function isTicTacToeRewriteFailure(sniff: SniffResult): boolean {
  const missing = new Set(sniff.missingRequiredSignals ?? []);
  return (
    missing.has('grid') ||
    missing.has('click') ||
    missing.has('win-detect') ||
    (missing.has('name') && (missing.has('js-size-ok') || sniff.signals.includes('js-parses'))) ||
    isTicTacToeThinScriptFailure(sniff)
  );
}

function isTicTacToeThinScriptFailure(sniff: SniffResult): boolean {
  const missing = new Set(sniff.missingRequiredSignals ?? []);
  if (!missing.has('js-size-ok')) return false;
  const hasGameStructure =
    sniff.signals.includes('name') &&
    sniff.signals.includes('grid') &&
    sniff.signals.includes('click') &&
    sniff.signals.includes('win-detect') &&
    sniff.signals.includes('js-parses');
  return (
    hasGameStructure ||
    /tic-tac-toe is functional but minimal|inline JS is only/i.test(sniff.failReason ?? '')
  );
}

/**
 * Per-context absent-poll counters for {@link postMissingDeliverableFeedback}.
 * Keyed by EvalContext (auto-cleanup on trial end), then by deliverable path.
 * Tracks how many consecutive polls have seen the deliverable file missing,
 * plus how many directive nudges we've already sent for it.
 */
const missingDeliverableState = new WeakMap<
  EvalContext,
  Map<
    string,
    {
      absentPolls: number;
      nudgesSent: number;
      lastNearMissKey?: string;
      lastTargetGezelId?: string;
      firstSeenTargetGezelId?: string;
      firstSeenTargetAtPoll?: number;
      coordinatorFallbackSentAtPoll?: number;
      lastNudgeSentAtPoll?: number;
    }
  >
>();

export interface MissingDeliverableNearMiss {
  path: string;
  location: string;
  bytes?: number;
}

export interface MissingDeliverableFeedbackOptions {
  minPolls?: number;
  repeatEvery?: number;
  maxNudges?: number;
  inflightGraceMs?: number;
  nearMiss?: MissingDeliverableNearMiss;
  coordinatorFallbackAfterPolls?: number;
  targetGracePolls?: number;
  projectId?: string;
  repairDirective?: string;
  /**
   * Surface the deliverable is graded on. Defaults to `'workspace'`, which
   * is what every message below assumes — they prescribe `write_file` and
   * `copy_artifact_to_workspace`.
   *
   * Pass `'artifact'` for a deliverable declared `artifact: true`, so a
   * near-miss found in the WORKSPACE is answered with the move that actually
   * fixes it. Without this the wording inverts: a model that wrote
   * `tasks/1/review.md` to the workspace is told to "create or replace the
   * exact file `tasks/1/review.md`" — which it just did — because the path is
   * identical and only the drawer is wrong.
   */
  expectedSurface?: 'workspace' | 'artifact';
}

/**
 * The read-then-never-write stall. Distinct from {@link postSniffFeedback},
 * which fires when the deliverable EXISTS but misses signals. This fires
 * when the deliverable is still **absent** after the team has had time to
 * read its inputs — the exact failure of the qwen3.5 squisq-review
 * + incident-postmortem trials (analytical role read 10+ files, stalled, never
 * called `write_file`; sniff sat at `rp0:rf0`). squisq-review posted no scenario
 * feedback at all; incident only nudged the file-EXISTS branch.
 *
 * Behavior: each call (one per absent poll) increments the absent counter.
 * Once it crosses `minPolls` (a reading grace period), posts a DIRECTIVE
 * "no `<file>` exists yet — stop reading and write it now" message, then
 * re-posts every `repeatEvery` polls up to `maxNudges` total (so a stuck
 * tiny model gets a few pushes without running to the hard ceiling). The
 * counter resets the moment the file appears (caller stops invoking this).
 *
 * Target: the most-recently-active non-meester specialist if one exists,
 * else the meester itself (`sendChatMessage`) — squisq's 4b stall was the
 * Meester idling before it even recruited a reviewer.
 */
export async function postMissingDeliverableFeedback(
  ctx: EvalContext,
  filePath: string,
  opts: MissingDeliverableFeedbackOptions = {},
): Promise<void> {
  const minPolls = opts.minPolls ?? 24; // ~2 min at the 5s poll cadence
  const repeatEvery = opts.repeatEvery ?? 30; // ~2.5 min between re-nudges
  const maxNudges = opts.maxNudges ?? 3;
  const inflightGraceMs = opts.inflightGraceMs ?? INFLIGHT_FEEDBACK_DEFER_MS;
  const coordinatorFallbackAfterPolls = opts.coordinatorFallbackAfterPolls ?? minPolls;
  const targetGracePolls = opts.targetGracePolls ?? 0;

  let perCtx = missingDeliverableState.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    missingDeliverableState.set(ctx, perCtx);
  }
  const state = perCtx.get(filePath) ?? { absentPolls: 0, nudgesSent: 0 };
  state.absentPolls += 1;
  perCtx.set(filePath, state);

  if (state.absentPolls < minPolls) return;

  const minimumScore = missingDeliverableMinimumTargetScore(filePath);
  const specialist = await pickTargetGezel(ctx, filePath, {
    minimumScore,
    projectId: opts.projectId,
  });
  const coordinatorFallback =
    !specialist && minimumScore != null && state.absentPolls >= coordinatorFallbackAfterPolls;
  if (specialist) {
    if (state.firstSeenTargetGezelId !== specialist.gezelId) {
      state.firstSeenTargetGezelId = specialist.gezelId;
      state.firstSeenTargetAtPoll = state.absentPolls;
      perCtx.set(filePath, state);
    }
    const firstSeenAt = state.firstSeenTargetAtPoll ?? state.absentPolls;
    if (targetGracePolls > 0 && state.absentPolls - firstSeenAt < targetGracePolls) {
      logFeedbackDeferral(
        ctx,
        `missing:${filePath}:${specialist.gezelId}:${opts.projectId ?? specialist.projectId ?? 'default'}:target-grace`,
        `[sniff-feedback] missing-deliverable nudge for ${filePath} deferred (target ${specialist.gezelId} first seen ${state.absentPolls - firstSeenAt}/${targetGracePolls} polls ago)`,
      );
      return;
    }
  }
  const shouldEscalateToCoordinator =
    !specialist && minimumScore != null && state.absentPolls >= coordinatorFallbackAfterPolls;
  if (
    shouldEscalateToCoordinator &&
    state.coordinatorFallbackSentAtPoll !== undefined &&
    state.absentPolls - state.coordinatorFallbackSentAtPoll < repeatEvery
  ) {
    logFeedbackDeferral(
      ctx,
      `missing:${filePath}:coordinator:repeat-window`,
      `[sniff-feedback] missing-deliverable coordinator fallback for ${filePath} deferred (last sent ${state.absentPolls - state.coordinatorFallbackSentAtPoll}/${repeatEvery} polls ago)`,
    );
    return;
  }
  const nearMissKey = opts.nearMiss ? opts.nearMiss.location : undefined;
  const newNearMiss = !!nearMissKey && state.lastNearMissKey !== nearMissKey;
  const urgentWrongSurfaceNearMiss =
    newNearMiss && isExactWrongSurfaceNearMiss(filePath, opts.nearMiss);
  const newTarget = !!specialist?.gezelId && specialist.gezelId !== state.lastTargetGezelId;
  if (state.nudgesSent >= maxNudges && !newNearMiss && !newTarget) return;
  if (
    !newNearMiss &&
    !newTarget &&
    state.nudgesSent > 0 &&
    state.lastNudgeSentAtPoll !== undefined &&
    state.absentPolls - state.lastNudgeSentAtPoll < repeatEvery
  ) {
    return;
  }
  const text = formatMissingDeliverableNudge(filePath, opts.nearMiss, {
    coordinatorFallback:
      coordinatorFallback ||
      urgentWrongSurfaceNearMiss ||
      (!specialist && minimumScore != null && state.absentPolls >= coordinatorFallbackAfterPolls),
    repairDirective: opts.repairDirective,
    expectedSurface: opts.expectedSurface,
  });
  let attemptedTargetId = specialist?.gezelId;
  try {
    if (specialist && !urgentWrongSurfaceNearMiss) {
      const deliveryProjectId = opts.projectId ?? specialist.projectId;
      const inflight = await targetInflightTurn(ctx, specialist, deliveryProjectId);
      if (inflight && inflight.elapsedMs < inflightGraceMs) {
        logFeedbackDeferral(
          ctx,
          `missing:${filePath}:${specialist.gezelId}:${deliveryProjectId ?? 'default'}:inflight`,
          `[sniff-feedback] missing-deliverable nudge for ${filePath} deferred; target ${specialist.gezelId} is still mid-turn for ${Math.round(inflight.elapsedMs / 1000)}s${deliveryProjectId ? ` in project ${deliveryProjectId}` : ''}`,
        );
        return;
      }
      await ctx.client.messageGezel(specialist.gezelId, {
        fileTurnIntent: { kind: 'create-file', path: filePath },
        fromGezelId: ctx.meesterId,
        text,
        suppressReply: true,
        ...attachableDeliverable(filePath, specialist.role, ctx.log),
        ...(deliveryProjectId ? { projectId: deliveryProjectId } : {}),
      });
      ctx.log(
        `[sniff-feedback] missing-deliverable nudge #${state.nudgesSent + 1} → specialist ${specialist.gezelId} for ${filePath} (absent ${state.absentPolls} polls)`,
      );
    } else if (minimumScore != null || urgentWrongSurfaceNearMiss) {
      if (state.absentPolls >= coordinatorFallbackAfterPolls || urgentWrongSurfaceNearMiss) {
        if (urgentWrongSurfaceNearMiss && specialist) {
          const deliveryProjectId = opts.projectId ?? specialist.projectId;
          const inflight = await targetInflightTurn(ctx, specialist, deliveryProjectId);
          if (inflight) {
            ctx.log(
              `[sniff-feedback] missing-deliverable wrong-surface developer handoff for ${filePath}; original target ${specialist.gezelId} is still mid-turn for ${Math.round(inflight.elapsedMs / 1000)}s${deliveryProjectId ? ` in project ${deliveryProjectId}` : ''}`,
            );
          }
        }
        const ensured = await ctx.client.ensureGezel({
          jobTitle: 'Developer',
        });
        attemptedTargetId = ensured.gezelId;
        await ctx.client.messageGezel(ensured.gezelId, {
          fromGezelId: ctx.meesterId,
          text,
          suppressReply: true,
          ...attachableDeliverable(filePath, ensured.role ?? 'Developer', ctx.log),
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
        });
        state.coordinatorFallbackSentAtPoll = state.absentPolls;
        state.lastTargetGezelId = ensured.gezelId;
        const reason = urgentWrongSurfaceNearMiss
          ? `wrong-surface near-miss at ${opts.nearMiss?.location ?? 'unknown location'}`
          : `no implementation specialist after ${state.absentPolls} polls`;
        ctx.log(
          `[sniff-feedback] missing-deliverable nudge #${state.nudgesSent + 1} -> ensured developer ${ensured.gezelId} for ${filePath} (${reason})`,
        );
      } else {
        logFeedbackDeferral(
          ctx,
          `missing:${filePath}:coordinator:no-specialist`,
          `[sniff-feedback] missing-deliverable nudge for ${filePath} deferred (no implementation specialist yet, absent ${state.absentPolls} polls)`,
        );
        return;
      }
    } else {
      await ctx.client.sendChatMessage(ctx.meesterId, {
        message: text,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      });
      ctx.log(
        `[sniff-feedback] missing-deliverable nudge #${state.nudgesSent + 1} → meester ${ctx.meesterId} for ${filePath} (no specialist yet, absent ${state.absentPolls} polls)`,
      );
    }
    state.nudgesSent += 1;
    state.lastNudgeSentAtPoll = state.absentPolls;
    noteHarnessInterventionDelivered(ctx);
    if (specialist?.gezelId && !urgentWrongSurfaceNearMiss) {
      state.lastTargetGezelId = specialist.gezelId;
    }
    if (nearMissKey) state.lastNearMissKey = nearMissKey;
    perCtx.set(filePath, state);
  } catch (err) {
    const msg = describeSendFailure(err);
    if (isPermanentHandoffError(err)) {
      // Suppress this exact, permanently-rejected target while still allowing
      // a newly selected specialist to receive the repair later.
      state.nudgesSent = maxNudges;
      if (attemptedTargetId) state.lastTargetGezelId = attemptedTargetId;
      if (nearMissKey) state.lastNearMissKey = nearMissKey;
      perCtx.set(filePath, state);
      ctx.log(
        `[sniff-feedback] suppressing repeated missing-deliverable sends to ${attemptedTargetId ?? 'unknown target'} after permanent client error`,
      );
    }
    ctx.log(`[sniff-feedback] missing-deliverable nudge failed for ${filePath}: ${msg}`);
  }
}

function isExactWrongSurfaceNearMiss(
  filePath: string,
  nearMiss: MissingDeliverableNearMiss | undefined,
): boolean {
  if (!nearMiss) return false;
  const expected = normalizeDeliverablePath(filePath);
  const nearPath = normalizeDeliverablePath(nearMiss.path);
  const location = normalizeDeliverablePath(nearMiss.location);
  const exactPath = nearPath === expected || location.endsWith(`/${expected}`);
  if (!exactPath) return false;
  return location !== `workspace/${expected}`;
}

function normalizeDeliverablePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

/**
 * Directive nudge for the absent-deliverable case. Names the exact path +
 * the exact tool call, and orders the model to write NOW. Deliberately
 * blunter than {@link formatNudge} — the failure mode is inaction, so the
 * message is an instruction, not a critique.
 */
function formatMissingDeliverableNudge(
  filePath: string,
  nearMiss?: MissingDeliverableNearMiss,
  opts: {
    coordinatorFallback?: boolean;
    repairDirective?: string;
    expectedSurface?: 'workspace' | 'artifact';
  } = {},
): string {
  const isHtml = /\.html?$/i.test(filePath);
  const isBinaryDocument = isBinaryDocumentDeliverablePath(filePath);
  const deliverableHint = isBinaryDocument
    ? 'Produce the real requested binary through the already-active craftbook production workflow; a text file with the right extension is invalid.'
    : isHtml
      ? 'Build the actual browser deliverable now: a complete, self-contained HTML file with the requested UI and behavior.'
      : 'Write the actual deliverable file now with the requested content.';
  const handoffHint = isBinaryDocument
    ? 'Do not convert this into an ad-hoc Developer/file handoff. Continue the active document craftbook: author/review the source, convert and preview with DocBlocks, save the artifact, then copy its real bytes to the exact workspace path.'
    : isHtml || isSourceFile(filePath)
      ? `If your current role does not have \`write_file\`, do not translate this into another planning, design, review, or image request. Make a blocking file handoff instead: first call \`ensure_gezel\` for a Builder/Developer, then call \`message_gezel\` for that gezel with \`expectedDeliverable: { kind: "file", filePath: "${filePath}" }\` and tell them to write \`${filePath}\` now. Do not call \`ask_specialist\` for this file deliverable.`
      : '';
  const artifactCopySource = artifactNearMissSource(filePath, nearMiss);
  const landingInstruction = isBinaryDocument
    ? `${deliverableHint} Use DocBlocks \`convert_document\` from the approved Markdown, \`preview_document\` for visual QA, and \`save_artifact\` with destination path \`${filePath}\`; then call \`copy_artifact_to_workspace({ source: "${filePath}", dest: "${filePath}" })\`. Do not call \`write_file\` for \`${filePath}\`.`
    : artifactCopySource
      ? `Fast path: because the near-miss is already in artifacts, land it in the workspace now with \`copy_artifact_to_workspace({ source: "${artifactCopySource}", dest: "${filePath}" })\` if that tool is available; otherwise read the artifact and call \`write_file({ path: "${filePath}", content: <the full deliverable contents> })\`. Pass the destination path exactly as \`${filePath}\` (workspace-root-relative — NOT \`workspace/${filePath}\`).`
      : `${deliverableHint} Stop reading/planning and write the file now: \`write_file({ path: "${filePath}", content: <the full deliverable contents> })\`. Pass the path exactly as \`${filePath}\` (workspace-root-relative — NOT \`workspace/${filePath}\`).`;
  const landingToolPhrase = isBinaryDocument
    ? '`convert_document` → `preview_document` → `save_artifact` → `copy_artifact_to_workspace`'
    : artifactCopySource
      ? '`copy_artifact_to_workspace` or `write_file`'
      : '`write_file`';
  // Same path, wrong drawer. Saying "create the exact file X" here is advice
  // the model has already followed, so name the SURFACE and the one call that
  // moves it.
  const wrongSurfaceOnly =
    opts.expectedSurface === 'artifact' &&
    nearMiss !== undefined &&
    normalizeDeliverablePath(nearMiss.location) ===
      `workspace/${normalizeDeliverablePath(filePath)}`;
  const nearMissLines = nearMiss
    ? wrongSurfaceOnly
      ? [
          `[scenario check] I did find \`${nearMiss.path}\`${nearMiss.bytes == null ? '' : ` (${nearMiss.bytes} bytes)`}, but in the WORKSPACE — this deliverable is graded in the artifacts drawer. The path is right; the surface is wrong.`,
          `Write it to the drawer with \`write_artifact({ path: "${filePath}", content: <the full deliverable contents> })\`. \`write_file\` puts it back in the workspace, where it will not count.`,
          '',
        ]
      : [
          `[scenario check] I did find \`${nearMiss.path}\` at \`${nearMiss.location}\`${nearMiss.bytes == null ? '' : ` (${nearMiss.bytes} bytes)`}, but that is the wrong deliverable path or location. A plan, notes file, artifact/library-only file, draft, or alternate filename does not count.`,
          isBinaryDocument
            ? `Resume the DocBlocks save/copy sequence now so the real binary lands at \`${filePath}\`; do not rewrite \`${nearMiss.path}\` as text.`
            : `Your next tool call must create or replace the exact file \`${filePath}\`. Do not keep expanding \`${nearMiss.path}\` unless you first move or rewrite it as \`${filePath}\`.`,
          '',
        ]
    : [];
  const coordinatorLines = opts.coordinatorFallback
    ? isBinaryDocument
      ? [
          '',
          'No production specialist is active yet. Resume or invoke the matching document craftbook and execute its DocBlocks production step; do not recruit a generic Developer or attach an ad-hoc binary expected-deliverable contract.',
        ]
      : [
          '',
          'No implementation specialist is active yet. If you are coordinating this project, immediately create or ensure a Developer/Builder and send them this exact deliverable directive, or write the file yourself before ending the turn. For HTML/source files, do not delegate the shipping file to a Designer and do not ask anyone to paste file contents in chat. A Designer can supply visual direction or assets; the Developer/Builder writes the workspace file.',
          `The handoff must include \`expectedDeliverable: { kind: "file", filePath: "${filePath}" }\` so the assignee writes the workspace file instead of answering in chat.`,
        ]
    : [];
  const completionLine = isBinaryDocument
    ? `Artifact-only plans, notes, and chat summaries do not satisfy this scenario. Do not end your turn until ${landingToolPhrase} has landed the real binary workspace file. If you delegated this, the production work has not happened: resume the craftbook step and complete it.`
    : `Artifact-only plans, notes, and chat summaries do not satisfy this scenario. Write what you have, even if incomplete — a partial file that you then extend with \`replace_in_file\`/\`append_to_file\` beats nothing. Do not end your turn until ${landingToolPhrase} has landed the workspace file. If you delegated this, the work has not happened: assign it explicitly or write it yourself.`;
  return [
    ...nearMissLines,
    `[scenario check] There is still **no \`${filePath}\`** in the workspace. The deliverable is the FILE — prose in chat does not count and will not be seen.`,
    '',
    ...(opts.repairDirective ? [opts.repairDirective, ''] : []),
    landingInstruction,
    handoffHint,
    '',
    `If \`${filePath}\` already exists by the time you read this queued message, treat this message as stale: re-read \`${filePath}\` and patch the latest concrete scenario-check failure instead of rewriting from scratch or replying in prose.`,
    ...coordinatorLines,
    '',
    completionLine,
  ].join('\n');
}

function artifactNearMissSource(
  filePath: string,
  nearMiss: MissingDeliverableNearMiss | undefined,
): string | null {
  if (!nearMiss || !isExactWrongSurfaceNearMiss(filePath, nearMiss)) return null;
  const location = nearMiss.location.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!/^artifacts\//i.test(location)) return null;
  return location.replace(/^artifacts\//i, '') || nearMiss.path;
}

interface TargetGezel {
  gezelId: string;
  sessionId?: string;
  projectId?: string;
  role?: string | null;
}

interface TargetCandidate extends TargetGezel {
  role: string | null;
}

interface PickTargetOptions {
  minimumScore?: number;
  projectId?: string;
  targetGezelId?: string;
}

async function pickTargetGezel(
  ctx: EvalContext,
  filePath: string,
  opts: PickTargetOptions = {},
): Promise<TargetGezel | null> {
  const { sessions } = await ctx.client.listChatSessions();
  const candidates: TargetGezel[] = sessions
    .filter((s) => s.gezelId !== ctx.meesterId && !s.archived)
    .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
    .map((s) => ({ gezelId: s.gezelId, sessionId: s.id, projectId: s.projectId }));
  if (opts.targetGezelId) {
    const existing = candidates.find((candidate) => candidate.gezelId === opts.targetGezelId);
    if (existing) {
      const roleMap = await loadGezelRoles(ctx);
      return { ...existing, role: roleMap.get(existing.gezelId) ?? null };
    }
    return {
      gezelId: opts.targetGezelId,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
    };
  }

  const roleMap = await loadGezelRoles(ctx);
  const targetProjectId = opts.projectId ?? inferSingleActiveProjectId(candidates);
  if (opts.minimumScore != null && roleMap.size > 0 && targetProjectId) {
    for (const [gezelId, role] of roleMap) {
      if (
        gezelId !== ctx.meesterId &&
        !candidates.some((candidate) => candidate.gezelId === gezelId) &&
        targetScoreForFile(role, filePath) >= opts.minimumScore
      ) {
        candidates.push({ gezelId, projectId: targetProjectId });
      }
    }
  }
  if (candidates.length === 0) return null;

  const withRoles: TargetCandidate[] = candidates.map((candidate) => ({
    ...candidate,
    role: roleMap.get(candidate.gezelId) ?? null,
  }));
  const scored = withRoles.map((candidate) => ({
    ...candidate,
    score: targetScoreForFile(candidate.role, filePath),
  }));
  const bestScore = Math.max(...scored.map((candidate) => candidate.score));
  if (opts.minimumScore != null && roleMap.size > 0 && bestScore < opts.minimumScore) {
    return null;
  }
  const preferred =
    bestScore > 0 ? scored.find((candidate) => candidate.score === bestScore) : undefined;
  const fallback = withRoles.find((candidate) => !isPoorTargetForFile(candidate.role, filePath));
  const defaultTarget = withRoles[0];
  if (!defaultTarget) return null;
  const top = preferred ?? fallback;
  const target = top ?? defaultTarget;
  return {
    gezelId: target.gezelId,
    sessionId: target.sessionId,
    projectId: target.projectId,
    role: target.role,
  };
}

async function targetInflightTurn(
  ctx: EvalContext,
  target: TargetGezel,
  projectId?: string,
): Promise<{ elapsedMs: number } | null> {
  const maybeClient = ctx.client as unknown as {
    listInflightTurns?: (opts?: { projectId?: string; gezelId?: string }) => Promise<{
      inflight?: Array<{
        sessionId?: string;
        gezelId: string;
        projectId?: string;
        elapsedMs?: number;
      }>;
    }>;
  };
  if (typeof maybeClient.listInflightTurns !== 'function') return null;

  try {
    const { inflight = [] } = await maybeClient.listInflightTurns({
      gezelId: target.gezelId,
      ...(projectId ? { projectId } : {}),
    });
    const matches = inflight.filter((turn) => {
      if (turn.gezelId !== target.gezelId) return false;
      if (target.sessionId && turn.sessionId && turn.sessionId !== target.sessionId) return false;
      return !projectId || !turn.projectId || turn.projectId === projectId;
    });
    if (matches.length === 0) return null;
    const elapsedMs = Math.max(...matches.map((turn) => turn.elapsedMs ?? 0));
    return { elapsedMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`[sniff-feedback] inflight check failed for ${target.gezelId}: ${msg}`);
    return null;
  }
}

function inferSingleActiveProjectId(candidates: TargetGezel[]): string | undefined {
  const projectIds = new Set(
    candidates
      .map((candidate) => candidate.projectId)
      .filter((projectId): projectId is string => !!projectId && projectId !== 'default'),
  );
  if (projectIds.size !== 1) return undefined;
  return [...projectIds][0];
}

async function loadGezelRoles(ctx: EvalContext): Promise<Map<string, string>> {
  const maybeClient = ctx.client as unknown as {
    listGezels?: () => Promise<{
      gezels: Array<{ id: string; role?: string | null; roleBasedName?: string | null }>;
    }>;
  };
  if (typeof maybeClient.listGezels !== 'function') return new Map();
  try {
    const { gezels } = await maybeClient.listGezels();
    return new Map(
      gezels.map((gezel) => [
        gezel.id,
        `${gezel.role ?? ''} ${gezel.roleBasedName ?? ''}`.trim().toLowerCase(),
      ]),
    );
  } catch {
    return new Map();
  }
}

function targetScoreForFile(role: string | null, filePath: string): number {
  if (!role) return 0;
  if (isImageFile(filePath)) return /image|visual|designer|artist/.test(role) ? 3 : 0;
  if (/\.(?:md|markdown|txt)$/i.test(filePath)) {
    if (/developer|builder|engineer/.test(role)) return 4;
    if (/review|research|writer|copy|sre|operator/.test(role)) return 3;
    if (/voorman|foreman/.test(role)) return 1;
    return 0;
  }
  if (/developer|builder|engineer|frontend|front-end|web/.test(role)) return 3;
  if (/voorman|foreman/.test(role)) return 1;
  return 0;
}

function isPoorTargetForFile(role: string | null, filePath: string): boolean {
  if (!role) return false;
  if (isImageFile(filePath)) return false;
  return /image|audio|speech|transcrib|artist/.test(role);
}

function missingDeliverableMinimumTargetScore(filePath: string): number | undefined {
  if (isImageFile(filePath)) return 3;
  if (
    /\.(?:html?|css|mjs|cjs|jsx?|tsx?|json|ya?ml|toml|py|rb|go|rs|java|cs|c|cc|cpp|h|hpp)$/i.test(
      filePath,
    )
  ) {
    return 2;
  }
  if (/\.(?:md|markdown|txt)$/i.test(filePath)) return 2;
  return undefined;
}

function isImageFile(filePath: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|svg)$/i.test(filePath);
}

function isSourceFile(filePath: string): boolean {
  return /\.(?:html?|css|mjs|cjs|jsx?|tsx?|json|ya?ml|toml|py|rb|go|rs|java|cs|c|cc|cpp|h|hpp)$/i.test(
    filePath,
  );
}

/**
 * Test-only escape hatch: clear the dedup memory for a context.
 */
export function _resetSniffNudgeMemoryForTests(ctx: EvalContext): void {
  nudgeMemory.delete(ctx);
  permanentNudgeFailureMemory.delete(ctx);
  escalationMemory.delete(ctx);
}
