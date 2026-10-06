/**
 * Policy for synchronous gezel-to-gezel consultations (`ask_gezel`): how deep
 * a chain may go, how long the asker waits on a silent target, which calls
 * coalesce into one flight, and how a target's failure is worded for the
 * gezel that asked. The waiting itself lives in `ChatManager.askGezelAndWait`.
 */
import {
  type ExpectedDeliverable,
  type GezelGender,
  type ModelTier,
  isLocalProvider,
  pronounFormsForGender,
} from '@bendyline/gezel';
import type { ProviderName } from '../providers/types.js';

/**
 * Maximum chain depth for sync `ask_gezel` calls. A chain like A→B→C is
 * depth 2; the cap defaults to 5 — enough for legitimate consultation
 * trees (Meester asks Builder, Builder asks Reviewer) without letting
 * runaway recursion pile up workers.
 */
export const DEFAULT_ASK_MAX_DEPTH = 5;

/**
 * Default and bounds for `askGezelAndWait`'s per-call timeout. This is
 * an **idle** budget — the max time the consulted gezel may go *silent*
 * (no tokens / tool calls) before the asker gives up — not a wall-clock
 * cap on the whole reply. See `waitForNextTurnComplete`. The ordinary
 * default is 5 min; DS4/frontier-size local targets get a 15 min floor so
 * measured load/prefill latency is not mistaken for a dead specialist.
 * `MAX_ASK_TIMEOUT_MS` is the separate absolute ceiling regardless of
 * activity.
 */
const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_ASK_TIMEOUT_MS = 10 * 1000;
export const MAX_ASK_TIMEOUT_MS = 30 * 60 * 1000;
function clampAskTimeout(ms: number): number {
  if (ms < MIN_ASK_TIMEOUT_MS) return MIN_ASK_TIMEOUT_MS;
  if (ms > MAX_ASK_TIMEOUT_MS) return MAX_ASK_TIMEOUT_MS;
  return ms;
}

/**
 * Translate a DOWNSTREAM delegate's failure into a message addressed to
 * the ASKER who delegated to them.
 *
 * The raw string a provider throws when a delegate's turn aborts is
 * written in the SECOND PERSON for the delegate who is mid-turn — e.g.
 * "Stop planning. Your next message MUST start with a single tool call.
 * If `write_file` is in your tool list, call it NOW with the full file
 * contents." Forwarded verbatim into the asker's `message_gezel` /
 * `ask_gezel` tool result (as it was before this helper existed), that
 * remediation is actively misleading: it reads as "YOU called this
 * wrong," so the orchestrator either thrashes its own (usually correct)
 * tool arguments chasing a phantom arg bug, or — worse — obeys the
 * coaching and fabricates a tool it doesn't even have.
 *
 * Wild-caught (Space Shooter Arcade): a voorman (Laxmi)
 * delegated `index.html` to a builder (Adam) whose turn ramble-aborted.
 * She received Adam's second-person abort verbatim, mutated her valid
 * `message_gezel` args (dropped the required `gezel`, added `project`)
 * hunting a non-existent argument error, then hallucinated a `write_file`
 * call she had no tool for and dumped the whole HTML as phantom markup —
 * exactly the anti-pattern the abort copy was trying to prevent in Adam.
 *
 * This returns an asker-facing line that attributes the failure to the
 * target and points at the orchestrator's real options, never echoing
 * delegate-facing "call write_file NOW" remediation back to a caller who
 * merely delegated.
 */
export function describeDelegateFailureForAsker(
  targetName: string,
  raw: string,
  targetGender?: GezelGender,
): string {
  const text = (raw ?? '').trim();
  // Ramble / planning-budget abort family. Every local provider emits
  // "aborting — the gezel emitted N characters of prose this turn
  // without calling any action tool. Stop planning. …" (see
  // ramble-detector.ts + the mlx / llama-cpp / ollama providers). Match
  // on the stable lead clause rather than the full second-person tail.
  if (/emitted\s+\d+\s+characters of prose this turn|\bStop planning\b/i.test(text)) {
    const pronouns = pronounFormsForGender(targetGender);
    return `${targetName} couldn't complete the request — ${pronouns.subject} spent ${pronouns.possessiveAdjective} whole turn planning without producing the deliverable. This is ${targetName}'s failure, not a problem with your call (it was delivered fine), so don't change your own tool arguments. Retry with a smaller, more concrete ask, reassign to a different gezel, or surface the blocker to the user.`;
  }
  // Generic downstream failure: preserve the underlying cause but make
  // ownership explicit so the asker doesn't read it as its own arg error.
  return text
    ? `${targetName} hit an error and couldn't reply: ${text}`
    : `${targetName} hit an error and couldn't reply.`;
}

export interface AskGezelArgs {
  fromGezelId: string;
  fromSessionId: string;
  toGezelIdOrName: string;
  projectId?: string;
  text: string;
  timeoutMs?: number;
  maxDepth?: number;
  /** Optional task to scope the consultation. Inherited from the asker's session when unset. */
  taskRef?: string;
  /** Optional step within `taskRef`. */
  stepId?: string;
  /**
   * Shape-of-deliverable hint persisted on the fresh consultation session.
   * File-shaped asks instruct the target to write the deliverable instead of
   * returning a long source/report body through chat.
   */
  expectedDeliverable?: ExpectedDeliverable;
}

/**
 * Discriminated outcome of `ChatManager.askGezelAndWait`. Mirrors the
 * `RequestAskResponse` API shape but kept internal — the route handler
 * narrows it before serializing.
 */
export type AskGezelOutcome =
  | {
      outcome: 'reply';
      text: string;
      toGezelId: string;
      toGezelName: string;
      sessionId: string;
    }
  | {
      outcome: 'error';
      reason:
        | 'cycle'
        | 'depth'
        | 'self'
        | 'not-found'
        | 'engagement-off'
        | 'timeout'
        | 'target-error'
        | 'target-deleted'
        | 'delivery-failed';
      message: string;
    };

const SLOW_LOCAL_CONSULTATION_IDLE_MS = 15 * 60 * 1000;

/**
 * Model-aware idle floor for synchronous consultations. An explicit caller
 * value may lengthen the budget but cannot undercut the measured first-action
 * envelope of DS4/frontier local models. Cloud and smaller local models retain
 * the historical configurable 5-minute default.
 */
export function consultationIdleTimeoutMsForModel(opts: {
  providerName: ProviderName;
  modelTier?: ModelTier;
  requestedTimeoutMs?: number;
}): number {
  const requested = clampAskTimeout(opts.requestedTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS);
  const slowLocal =
    opts.providerName === 'ds4' ||
    (isLocalProvider(opts.providerName) && opts.modelTier === 'large');
  return slowLocal ? Math.max(requested, SLOW_LOCAL_CONSULTATION_IDLE_MS) : requested;
}

/** Stable one-flight key for semantically identical consultation calls. */
export function consultationFlightKey(args: AskGezelArgs): string {
  const normalize = (value: string | undefined): string =>
    (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  // When project is omitted, inheritance is session-specific; keep those
  // calls scoped to the asker session to avoid coalescing equal questions
  // from two different projects. Explicit project calls can safely coalesce
  // across stale/recovery sessions belonging to the same gezel.
  const projectScope = args.projectId
    ? `project:${normalize(args.projectId)}`
    : `session:${args.fromSessionId}`;
  return JSON.stringify([
    args.fromGezelId,
    projectScope,
    normalize(args.toGezelIdOrName),
    normalize(args.text),
    normalize(args.taskRef),
    normalize(args.stepId),
    args.expectedDeliverable ?? null,
  ]);
}
