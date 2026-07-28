/**
 * Error thrown by the local-provider tool loop when a per-turn guard
 * (failure-loop, repeat-loop, deliverable read-pacing) decides the turn
 * is unrecoverable and must end.
 *
 * The abort has TWO distinct audiences that used to share one string:
 *
 *   1. **The model.** `message` is a direct, second-person corrective —
 *      "stop re-emitting the whole file, make one `replace_lines` edit",
 *      "hand off to `delegate_meester`", etc. This is the technical
 *      record: it lands on the synthetic `turn-aborted` message's
 *      `warnings` (for the session-debug bundle) and is what any upstream
 *      catcher sees on `err.message`.
 *
 *   2. **The user.** `userMessage` is a short, plain-language summary with
 *      no `[provider]` prefix and no model-coaching imperatives — what the
 *      "✗ Last turn failed: …" banner shows. The chat manager routes this
 *      to the `error` SSE event and persists it as `lastTurnError` so both
 *      the live banner and the reload banner read like something written
 *      for a human.
 *
 * Splitting them keeps the model steering aggressive (it was tuned against
 * real model misbehavior) while sparing the user the internal jargon.
 */
export class TurnAbortError extends Error {
  /** Plain-language summary for the user-facing failure banner. */
  readonly userMessage: string;

  /**
   * @param modelMessage Second-person corrective aimed at the model; becomes `message`.
   * @param userMessage  Plain summary aimed at the user; drives the banner.
   */
  constructor(modelMessage: string, userMessage: string) {
    super(modelMessage);
    this.name = 'TurnAbortError';
    this.userMessage = userMessage;
  }
}
