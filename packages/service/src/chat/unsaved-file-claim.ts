/**
 * Detector and re-prompt for a false file claim: the model's reply says it
 * saved, created, or edited a file ("saved to `review.md`", "`index.html` is
 * in place", "I updated `index.html`") while no write landed this turn.
 */
import type { ChatMessageToolCall } from '@bendyline/gezel';

/**
 * Detect file-save claims that weren't backed by a `write_file` /
 * `write_artifact` / `append_to_file` call this turn. Matches phrasings
 * the matrix #2 squisq-review case produced ("saved the full report to
 * `review.md`", "wrote the file at <path>"), and the broader family
 * those drift toward ("filed at", "written to", "I've saved <X> to
 * <path>"). The path is captured for the re-prompt so the model can
 * either follow through (`write_file({path:<captured>, content:<their
 * deliverable>})`) or correct the false claim.
 *
 * Conservative pattern by design — false positives feel adversarial to
 * the user when the model didn't actually claim what we say it did. We
 * require:
 *   1. A claim verb in past tense AND
 *   2. A capture-group path with a file extension (so "saved to disk" /
 *      "filed in workspace" don't fire) AND
 *   3. The path NOT being something the message also called read-only
 *      (e.g. "read review.md" — past-tense "read" matches but our verb
 *      list excludes it).
 *
 * Returns the captured path on match for use in the re-prompt; null
 * when no claim is detected.
 */
const SAVE_CLAIM_PATTERNS = [
  // `saved to <path>` / `saved the report to <path>` / `saved <something> to <path>`
  /\bsaved\b(?:[\s\S]{0,80}?)\bto\s+[`'"]?([\w./\-]+\.[a-z0-9]{1,6})[`'"]?/i,
  // `wrote (it|the file|the review|<name>) to <path>` / `wrote <path>`
  /\bwrote\b(?:[\s\S]{0,80}?)\bto\s+[`'"]?([\w./\-]+\.[a-z0-9]{1,6})[`'"]?/i,
  /\bwrote\s+[`'"]?([\w./\-]+\.[a-z0-9]{1,6})[`'"]?/i,
  // `filed (the report) (at|in|as) <path>` / `filed at <path>`
  /\bfiled\b(?:[\s\S]{0,80}?)\b(?:at|in|as)\s+[`'"]?([\w./\-]+\.[a-z0-9]{1,6})[`'"]?/i,
  // `written to <path>` (passive voice, common with Meester relaying)
  /\bwritten\s+to\s+[`'"]?([\w./\-]+\.[a-z0-9]{1,6})[`'"]?/i,
];

/**
 * Existence / completion claims — the family the write-verb patterns
 * above miss. Wild-caught (Space Shooter Arcade): a voorman
 * with no `write_file` told the Meester the deliverable "is in place",
 * "exists", "is complete" three times — none of which match `saved/wrote/
 * filed/written to`, so the unsaved-file-claim guard never fired and the
 * false "done" stood. These are stricter than the write-verb patterns
 * (path MUST be quoted/backticked) because completion language is far
 * more common in ordinary prose — the call site's workspace cross-check
 * is the authoritative false-positive guard regardless.
 */
const COMPLETION_CLAIM_PATTERNS = [
  // "`index.html` is in place / is complete / is done / has been delivered"
  /[`'"]([\w./\-]+\.[a-z0-9]{1,6})[`'"]\s+(?:is|has been|was)\s+(?:in place|complete|completed|done|ready|created|delivered|finished|live|saved|generated)\b/i,
  // "delivered / created / completed / shipped (the X) `index.html`"
  /\b(?:delivered|created|completed|finished|shipped|produced|generated)\s+(?:the\s+[\w-]+\s+)?[`'"]([\w./\-]+\.[a-z0-9]{1,6})[`'"]/i,
  // "`index.html` exists"
  /[`'"]([\w./\-]+\.[a-z0-9]{1,6})[`'"]\s+exists\b/i,
];

/**
 * Modify / edit claims — "updated `index.html`", "modified the Enemy class
 * in `index.html`", "applied the change to `index.html`". The save and
 * completion patterns miss these entirely: their verb lists are about
 * bringing a file into EXISTENCE, not editing one that's already there.
 * Wild-caught (qwen3.6 developer "Space Shooter Arcade"): asked
 * to subtract 50 points, the model read the file, reasoned out the exact
 * `replace_in_file` edit, then emitted "I have updated the game logic in
 * `index.html`" with NO write call — the edit never landed and nothing
 * caught the false claim. Path MUST be quoted/backticked (edit language is
 * common in ordinary prose); the call site fires for these REGARDLESS of
 * on-disk existence, since an existing file says nothing about whether this
 * turn's edit actually happened.
 */
const MODIFY_CLAIM_PATTERNS = [
  // "updated / modified / edited / changed / patched / refactored / replaced
  //  (… in)? `index.html`"
  /\b(?:updated|modified|edited|changed|adjusted|patched|refactored|revised|tweaked|replaced)\b(?:[\s\S]{0,80}?)[`'"]([\w./\-]+\.[a-z0-9]{1,6})[`'"]/i,
  // "applied the change(s) to `index.html`"
  /\bapplied\b(?:[\s\S]{0,80}?)\bto\s+[`'"]?([\w./\-]+\.[a-z0-9]{1,6})[`'"]?/i,
];

/**
 * A retraction ("the file was NOT created", "couldn't apply the change") is
 * the correction we WANT — never nag it as a false claim. Gates the
 * completion AND modify patterns (the write-verb patterns are past-tense-
 * specific and rarely collide with negations).
 */
const RETRACTION_PATTERN =
  /\b(?:not|never|no longer|isn't|wasn't|doesn't|hasn't|couldn't|can't|unable to)\b[^.]{0,40}\b(?:create|created|save|saved|wrote|written|complete|completed|done|in place|deliver|delivered|exist|exists|ready|generate|generated|update|updated|modif(?:y|ied)|edit|edited|change|changed|appl(?:y|ied))\b/i;

export function detectUnsavedFileClaim(
  content: string,
  toolCalls: ChatMessageToolCall[] | undefined,
): { claimedPath: string; kind: 'wrote' | 'exists' | 'modified' } | null {
  if (!content || content.length < 20) return null;
  // A successful file-writing call this turn excuses the prose — the
  // model both said "saved" and actually saved. `replace_in_file` counts:
  // it's how a targeted edit lands, and a "I updated X" claim backed by a
  // successful replace_in_file is TRUE. Failed writes do not excuse the
  // prose: the user sees the failed tool row, so a follow-up "I saved it"
  // must be corrected or retried.
  const wroteSomething = (toolCalls ?? []).some(
    (c) => (c.success || isRecoverableSavedDraftToolCall(c)) && isFileWritingEvidenceToolCall(c),
  );
  if (wroteSomething) return null;
  // First-person write-verb claims ("saved to X", "wrote X").
  for (const re of SAVE_CLAIM_PATTERNS) {
    const m = content.match(re);
    if (m?.[1]) return { claimedPath: m[1], kind: 'wrote' };
  }
  // Modify/completion claims share the retraction guard ("X was NOT
  // changed" / "X was NOT created" is the correction we want, not a false
  // claim to nag).
  if (!RETRACTION_PATTERN.test(content)) {
    // Modify/edit claims ("updated `X`", "applied the change to `X`").
    // Checked before completion so "updated AND completed `X`" reads as the
    // stronger 'modified' verdict — unlike a create claim, an already-
    // existing file is NOT proof the edit landed, and the call site treats
    // 'modified' specially for exactly that reason.
    for (const re of MODIFY_CLAIM_PATTERNS) {
      const m = content.match(re);
      if (m?.[1]) return { claimedPath: m[1], kind: 'modified' };
    }
    // Existence / completion claims ("`X` is in place / exists / is done").
    for (const re of COMPLETION_CLAIM_PATTERNS) {
      const m = content.match(re);
      if (m?.[1]) return { claimedPath: m[1], kind: 'exists' };
    }
  }
  return null;
}

function isRecoverableSavedDraftToolCall(call: ChatMessageToolCall): boolean {
  return (
    call.name === 'write_file' &&
    call.success === false &&
    typeof call.errorMessage === 'string' &&
    /Invalid first draft\s+\S+\s+was saved anyway so you can continue with/i.test(call.errorMessage)
  );
}

function isFileWritingEvidenceToolCall(call: ChatMessageToolCall): boolean {
  if (
    call.name === 'write_file' ||
    call.name === 'write_artifact' ||
    call.name === 'append_to_file' ||
    call.name === 'replace_in_file'
  ) {
    return true;
  }
  // CLI-backed providers expose native shell/file-edit actions instead
  // of gezel MCP write_file. A successful native action in the same turn
  // is enough evidence to avoid a false "no write landed" nudge; the
  // scenario/runtime check remains the authority on whether the edit was
  // actually correct.
  return call.name === 'shell' || call.name === 'file_change';
}

/**
 * Re-prompt template for the unsaved-file-claim case. Names the claimed
 * path verbatim so the model has a concrete target instead of guessing.
 * Two valid resolutions: actually write the file, or retract the claim.
 * Both keep the user-visible thread truthful — the worst outcome is
 * leaving the false claim standing.
 */
export function buildUnsavedFileClaimNudge(
  claimedPath: string,
  canWrite: boolean,
  kind: 'wrote' | 'exists' | 'modified' = 'wrote',
): string {
  // Delegator role (no `write_file`) — the voorman/meester case. Pointing
  // it at `write_file` would be the very mistake that started this; point
  // it at delegation + verification instead.
  if (!canWrite) {
    const verb = kind === 'modified' ? 'changed' : 'created';
    return `You implied the file at \`${claimedPath}\` was ${verb}, but you have no \`write_file\` tool in this role — nothing has been written. Do not claim it's done. Valid next moves:\n  1. DELEGATE: use \`message_gezel\` for the Builder/Developer you assigned this task to, or first call \`ensure_gezel\` for a Builder/Developer if none exists. Include \`expectedDeliverable: { kind: "file", filePath: "${claimedPath}" }\` and ask them to make the change and reply with the path. Do not call \`ask_specialist\` for file deliverables.\n  2. Once they deliver, confirm with \`read_file\` BEFORE telling anyone it's done.\n  3. If you genuinely cannot delegate, tell the user plainly the file was NOT ${verb} and what's blocking it.\nDo not leave the false claim standing.`;
  }
  // Modify claim — the file exists but this turn made no edit. Reading is
  // not editing; point at the patch tools, not a from-scratch write.
  if (kind === 'modified') {
    return `You said you changed \`${claimedPath}\` (e.g. "updated"/"modified"/"applied the change"), but no successful \`write_file\` / \`replace_in_file\` / \`append_to_file\` call landed this turn — the file on disk is UNCHANGED. Reading a file is not editing it. Valid next moves:\n  1. Apply the edit NOW: \`replace_in_file({ path: "${claimedPath}", find: <exact current snippet>, replace: <new snippet> })\` for a targeted change, or \`write_file({ path: "${claimedPath}", content: <full corrected file> })\` for a rewrite.\n  2. If you couldn't make the change, say plainly it was NOT applied and what's blocking it.\nDo not leave the false claim standing.`;
  }
  return `You said the file at \`${claimedPath}\` was saved, but no successful \`write_file\` / \`write_artifact\` / \`append_to_file\` call landed this turn — the file doesn't actually exist on disk. Valid next moves:\n  1. If you have workspace write access, call \`write_file({ path: "${claimedPath}", content: <the deliverable you described> })\` now. If you don't have the content ready, generate it in this turn and write it.\n  2. If you do not have workspace write access, hand off to a developer with the exact path and change needed.\n  3. If saving wasn't actually the right move, correct your previous statement — say plainly that the file was NOT saved and what you'll do instead.\nDo not leave the false claim standing.`;
}
