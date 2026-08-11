/**
 * Session-scoped ledger of tool calls that failed validation and were
 * never subsequently made to work — and the gate that stops a gezel from
 * declaring a phase done while one is outstanding.
 *
 * The failure this exists to catch: a gezel hits the same validation
 * error on the same tool over and over, concludes the *tool* is broken,
 * writes a task note saying so, and calls `advance_task_step` anyway —
 * passing the phase gate on a deliverable produced by some earlier
 * attempt. Wild-caught on task `default/3` step `publish`: nineteen
 * attempts, `convert_document` rejected every time, and the notes chain
 * shows each attempt teaching the next one that the blocker was
 * unfixable ("convert_document tool fails with persistent schema
 * validation errors — same blocker as attempts 15-18… Gate criteria met
 * by existing deliverable from attempt 15. Advancing."). The gate's
 * declarative checks passed because the file from attempt 15 was still
 * on disk, so nothing stopped the advance.
 *
 * The rule enforced here is narrow on purpose: you may not advance a
 * task step while a tool you invoked this session is sitting on a
 * REPEATED, IDENTICAL validation rejection with no later success. That
 * is a state where the work of this attempt demonstrably did not happen,
 * regardless of what is on disk from a previous one.
 *
 * Deliberately NOT blocked: transport faults, timeouts, permission
 * denials, and one-off mistakes the model corrected. Those are either
 * not the model's to fix or already fixed, and blocking on them would
 * wedge legitimate work.
 *
 * Scope is the session (the bridge pool's lifetime), and it spans every
 * bridge in that pool — the failing tool usually lives on a third-party
 * bridge (DocBlocks) while `advance_task_step` lives on gezel-mcp.
 */

import { createLogger } from '@bendyline/gezel';
import { canonicalToolName } from '@bendyline/gezel-mcp';

const log = createLogger('mcp-bridge');

/**
 * Identical failures needed before a tool is treated as unresolved.
 *
 * Two, not three: the signature match is already strict (same tool, same
 * normalized error text, no success in between), so a second identical
 * rejection means the model's correction attempt changed nothing. In the
 * incident this is drawn from, the deciding session logged exactly two
 * identical `convert_document` rejections before the gezel gave up and
 * advanced — a threshold of three would have let that through.
 */
const DEFAULT_REPEAT_THRESHOLD = 2;

/**
 * Tools whose success would declare work complete. Blocked while an
 * unresolved validation failure stands.
 *
 * `set_task_status` is deliberately absent: pausing or cancelling a task
 * is exactly the honest move for a gezel that cannot make a tool work,
 * and blocking that call would leave it with no legal way to stop.
 */
const DEFAULT_GATED_TOOLS: readonly string[] = ['advance_task_step'];

/**
 * Error shapes that mean "the arguments were rejected" — the only class
 * that counts here. Matches both the raw upstream Zod/MCP blob and the
 * plain-English rewrites from `zod-error-translator`.
 */
const VALIDATION_ERROR_PATTERNS: readonly RegExp[] = [
  /rejected by validator/i,
  /invalid arguments for tool/i,
  /\bmcp error -32602\b/i,
  /\bwrong type:/i,
  /\bmissing required fields:/i,
  /instead of a real object\/array/i,
];

export function isValidationFailure(text: string): boolean {
  return VALIDATION_ERROR_PATTERNS.some((re) => re.test(text));
}

/**
 * Collapse an error message to a comparison key. Whitespace and case are
 * noise; everything else is kept, because two rejections that differ in
 * WHICH field is wrong are genuinely different failures and the model
 * making progress between them should not be treated as spinning.
 */
function signature(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 600);
}

interface Entry {
  count: number;
  signature: string;
  lastMessage: string;
}

export interface UnresolvedToolFailureLedgerOpts {
  repeatThreshold?: number;
  gatedTools?: readonly string[];
}

export class UnresolvedToolFailureLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly repeatThreshold: number;
  private readonly gatedTools: ReadonlySet<string>;

  constructor(opts: UnresolvedToolFailureLedgerOpts = {}) {
    this.repeatThreshold = opts.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
    this.gatedTools = new Set(opts.gatedTools ?? DEFAULT_GATED_TOOLS);
  }

  /**
   * Fold one completed tool call into the ledger. Call with the FINAL
   * model-facing text, after error translation — that is the text the
   * model actually saw and re-reacted to, so it's the right thing to
   * compare for "identical".
   */
  record(advertisedName: string, text: string, isError: boolean): void {
    // Key on the canonical name so a legacy spelling and its canonical
    // form are the same tool — otherwise a naming-A/B session could fail
    // under one spelling and clear under the other.
    const toolName = canonicalToolName(advertisedName);
    if (!isError) {
      // Any success clears the tool: whatever was wrong, the model
      // found a shape that works and is no longer spinning.
      if (this.entries.delete(toolName)) {
        log.debug(`unresolved-failure ledger cleared for ${toolName} after a successful call`);
      }
      return;
    }
    if (!isValidationFailure(text)) return;
    const sig = signature(text);
    const prior = this.entries.get(toolName);
    if (prior && prior.signature === sig) {
      prior.count += 1;
      prior.lastMessage = text;
      if (prior.count === this.repeatThreshold) {
        log.info(
          `unresolved-failure ledger: ${toolName} has failed validation identically ${prior.count}× — step advancement is blocked until it succeeds`,
        );
      }
      return;
    }
    // A DIFFERENT validation error is progress of a kind — the model
    // changed something. Restart the count against the new signature
    // rather than accumulating across distinct problems.
    this.entries.set(toolName, { count: 1, signature: sig, lastMessage: text });
  }

  /** Tools currently sitting on a repeated, unresolved validation failure. */
  unresolved(): Array<{ toolName: string; count: number; lastMessage: string }> {
    const out: Array<{ toolName: string; count: number; lastMessage: string }> = [];
    for (const [toolName, entry] of this.entries) {
      if (entry.count >= this.repeatThreshold) {
        out.push({ toolName, count: entry.count, lastMessage: entry.lastMessage });
      }
    }
    return out;
  }

  /**
   * Reason to refuse `toolName`, or null to allow it. The returned text
   * is what the model sees as the tool result, so it names the blocker
   * and the two legal ways out — fix the call, or stop honestly.
   */
  blockReason(advertisedName: string): string | null {
    const toolName = canonicalToolName(advertisedName);
    if (!this.gatedTools.has(toolName)) return null;
    const blockers = this.unresolved();
    if (blockers.length === 0) return null;
    const list = blockers.map((b) => `\`${b.toolName}\` (${b.count}× identical)`).join(', ');
    const detail = blockers[0]!.lastMessage.trim();
    return [
      `ERROR: \`${advertisedName}\` refused — you have an unresolved tool failure this session: ${list}.`,
      'A step cannot be completed while a tool you needed is still rejecting your calls.',
      'Work already on disk from an EARLIER attempt does not satisfy this step: this attempt has to do the work.',
      '',
      `Last rejection: ${detail}`,
      '',
      'Two legal moves. (1) Fix the failing call and make it succeed — then advancing is allowed again.',
      '(2) If it genuinely cannot be made to work, stop: record what you tried with `write_task_note` and pause the task (`set_task_status` with `status: "paused"`) so a human can look. Do not claim the step is done.',
    ].join('\n');
  }
}
