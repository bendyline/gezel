/**
 * Human copy for a chat turn that was stopped from outside the model.
 *
 * Every cancellation used to surface as one provider string —
 * `[Mac AI] turn cancelled by caller`. Two things were wrong with it. The
 * engine tag reads as an engine fault when the engine did exactly what it
 * was told, and "caller" is the call stack's word for the chat manager,
 * which the person staring at the bubble has no way to resolve. The five
 * callers that actually stop a turn are all namable events the user either
 * caused or would recognize, so they are named here and the reason travels
 * from the site that knows it.
 *
 * The vocabulary lives in core because the service writes these strings and
 * the UI matches them ({@link isUserCancelledTurnError} decides whether the
 * bubble offers "Report error on GitHub…"). Split across packages, a
 * reworded message on one side is a match that silently stops firing on the
 * other.
 */

export type TurnCancelReason =
  /** The Stop button on the composer. */
  | 'user-stop'
  /** Interrupt: stop this turn, run these instructions instead. */
  | 'user-interrupt'
  /** Settings → emergency stop: halt everything at once. */
  | 'emergency-stop'
  /** The daemon is shutting down (app quit, restart, upgrade). */
  | 'service-restart'
  /** The task moved on: paused, cancelled, deleted, or the step re-dispatched. */
  | 'task-superseded'
  /** Something aborted the turn without saying what. */
  | 'unspecified';

export const TURN_CANCEL_MESSAGES: Record<TurnCancelReason, string> = {
  'user-stop': 'You stopped this turn.',
  'user-interrupt': 'You interrupted this turn with new instructions.',
  'emergency-stop': 'Emergency stop halted everything that was running.',
  'service-restart': 'Gezel shut down while this turn was still running.',
  'task-superseded':
    'The task moved on — paused, cancelled, or handed to someone else — so this turn was ended.',
  unspecified: 'This turn was stopped before the model finished.',
};

export function turnCancelledMessage(reason?: TurnCancelReason | null): string {
  return TURN_CANCEL_MESSAGES[reason ?? 'unspecified'];
}

const KNOWN_CANCEL_MESSAGES = new Set<string>(Object.values(TURN_CANCEL_MESSAGES));

/**
 * The pre-2026-08 provider wording. Sessions written before this change keep
 * it on disk forever, so the detector has to keep recognizing it.
 */
const LEGACY_CANCEL_PATTERN = /\bturn cancel(?:l)?ed by caller\b/i;

export function isTurnCancelledMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  if (LEGACY_CANCEL_PATTERN.test(message)) return true;
  // Provider strings carry a `[Mac AI]`-style tag; drop one if present so a
  // tagged copy of the same sentence still matches.
  return KNOWN_CANCEL_MESSAGES.has(message.trim().replace(/^\[[^\]]{1,40}\]\s*/, ''));
}
