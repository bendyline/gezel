/**
 * Per-turn consecutive-failure tracker for the local-provider tool
 * loop. Catches the failure mode where a model (Qwen 3.6 27B at heavy
 * quant in particular) keeps re-emitting a tool call with a
 * structurally-wrong argument shape, gets the same Zod-validation
 * error every time, "diagnoses" the schema in chat, and re-tries —
 * forever, until the 30-min wall-clock cap or 96-iteration loop cap
 * fires. Both backstops are too slow for a real user.
 *
 * Failure detection: most bridge failures are `ERROR:`-prefixed, but
 * some MCP handlers return plain teaching errors such as "replaceLines
 * was rejected..." or "Write failed: fetch failed". Treat those as
 * failures too so source-edit validation loops get the same guardrails.
 *
 * Counter scope is **per-tool-name**. A different tool succeeding does
 * NOT reset another tool's counter — the model could be ping-ponging
 * between two broken calls. The same tool succeeding on a different
 * arg shape DOES reset (the schema is satisfied, model recovered).
 *
 * Two thresholds:
 *   - `softWarningAt` (default 3) — append a runtime nudge to the
 *     tool result text the model sees on its next iteration. Tells it
 *     to stop retrying and either explain to the user or pick a
 *     different approach. The wording is structured to override the
 *     cookbook's retry-leaning rules.
 *   - `hardAbortAt` (default 5) — caller breaks the loop and surfaces
 *     a user-facing error. The transcript is preserved so debugging
 *     is possible.
 */

import { TurnAbortError } from './turn-abort-error.js';

const SOFT_WARNING_AT_DEFAULT = 3;
const HARD_ABORT_AT_DEFAULT = 5;

/**
 * `write_artifact` refusals caused by an existing workspace file at the
 * target path abort sooner than the generic limit. Unlike a malformed-args
 * error, retrying is *structurally* hopeless: the call shape is fine, the
 * PATH is the problem, so an identical retry can never succeed — and a role
 * without `writeFile` (a voorman) has no valid retry at all. The only
 * correct move is to hand off. We nudge toward a handoff from the FIRST
 * refusal (below) and abort after this many, instead of burning the full
 * `hardAbortAt` budget on a doomed call. Wild-caught (qwen3.6
 * voorman "Space Shooter Arcade"): after correctly delegating the change,
 * the foreman also tried to `write_artifact("script.js")` herself and
 * re-issued the identical refused call until the 5-fail hard abort killed
 * the turn.
 */
const ARTIFACT_COLLISION_ABORT_AT = 3;

export interface ToolFailureTrackerOpts {
  softWarningAt?: number;
  hardAbortAt?: number;
  /**
   * Surgical edit tools (`replaceInFile` / `insertAtMarker` / …) are on
   * the roster this turn — i.e. the deliverable is a MODIFICATION of an
   * existing file, not a fresh create. When set, a repeated source-edit
   * failure steers the model toward a targeted patch instead of the
   * default "re-emit the entire file" advice, which only re-corrupts a
   * large file a weak model can't reproduce. See the source-edit branches
   * in {@link recordResult} / {@link buildAbortMessage}.
   */
  surgicalEditsAvailable?: boolean;
  /**
   * Role-delegation tools (`delegate_meester` / `delegate_voorman` / …) are
   * on the roster this turn. When set, repeated source-edit failures steer
   * the model to HAND THE FILE to a more capable model instead of thrashing
   * to a plain abort — the edit-tool merry-go-round is a coordination/
   * coherence limit a bigger model clears, not something more nudging fixes.
   * Wild-caught: a gemma4-12b couldn't land any edit to a 9 KB
   * file (full rewrite truncated + guard-rejected, byte-match patches
   * missed) and just aborted, with delegate_* tools sitting unused.
   */
  delegationAvailable?: boolean;
}

export interface ToolFailureResult {
  /** The tool output, possibly augmented with a soft-warning footer. */
  output: string;
  /** True when the consecutive-fail count hit `hardAbortAt`. */
  shouldAbort: boolean;
  /** Current consecutive-fail count for this tool (0 when result was a success). */
  count: number;
  /** Source-write failure class used to choose the next-turn corrective. */
  sourceFailureKind?: 'truncated' | 'not-persisted';
}

export class ToolFailureTracker {
  private readonly failures = new Map<string, number>();
  private readonly softWarningAt: number;
  private readonly hardAbortAt: number;
  private readonly surgicalEditsAvailable: boolean;
  private readonly delegationAvailable: boolean;

  constructor(opts: ToolFailureTrackerOpts = {}) {
    this.softWarningAt = opts.softWarningAt ?? SOFT_WARNING_AT_DEFAULT;
    this.hardAbortAt = opts.hardAbortAt ?? HARD_ABORT_AT_DEFAULT;
    this.surgicalEditsAvailable = opts.surgicalEditsAvailable ?? false;
    this.delegationAvailable = opts.delegationAvailable ?? false;
  }

  /**
   * Record the outcome of one tool call. Returns the (possibly-
   * augmented) output the caller should hand back to the model, plus
   * a flag indicating the loop should now abort.
   */
  recordResult(toolName: string, output: string): ToolFailureResult {
    if (!isFailureOutput(output)) {
      // Success — reset this tool's counter.
      this.failures.set(toolName, 0);
      return { output, shouldAbort: false, count: 0 };
    }
    const fails = (this.failures.get(toolName) ?? 0) + 1;
    this.failures.set(toolName, fails);
    // Unrecoverable workspace-collision refusal: a short, handoff-shaped
    // nudge from the very first failure, and a lower abort ceiling. The
    // path (not the args) is wrong, so the generic "STOP retrying / pick a
    // different call shape" nudge — which only fires at `softWarningAt` —
    // is both too late and aimed at the wrong fix. There is no different
    // call shape; there is only a handoff.
    if (isUnrecoverableArtifactCollision(output)) {
      if (fails >= ARTIFACT_COLLISION_ABORT_AT) {
        return { output, shouldAbort: true, count: fails };
      }
      return {
        output: `${output}\n\n[runtime] \`${toolName}\` was refused because the path is a WORKSPACE file — this call will never succeed (you don't have workspace write access) and retrying is pointless. If you've already delegated this file to a developer, you're done: stop. Otherwise hand off NOW — e.g. \`message_gezel\` / \`delegate_developer\`, or \`ensure_gezel\` + \`create_task\` + \`assign_task\`. Do not call \`${toolName}\` for this path again.`,
        shouldAbort: false,
        count: fails,
      };
    }
    if (isDraftPlanGateFailure(toolName, output)) {
      if (fails >= this.hardAbortAt) {
        return { output, shouldAbort: true, count: fails };
      }
      return {
        output: `${output}\n\n[runtime] This draft-plan failure means one or more build steps still lack a deliverable gate. STOP calling \`${toolName}\`. Your next tool call must be \`set_step_deliverable\` for one exact step id listed above. Repeat one \`set_step_deliverable({ task, stepId, path, kind })\` call per listed ungated step, then continue. Do not narrate that gates were attached until \`set_step_deliverable\` returns success.`,
        shouldAbort: false,
        count: fails,
      };
    }
    if (fails >= this.hardAbortAt) {
      return { output, shouldAbort: true, count: fails };
    }
    if (fails >= this.softWarningAt) {
      if (isSourceEditFailureTool(toolName)) {
        const sourceFailureKind = isTruncatedSourceWriteFailure(output)
          ? 'truncated'
          : isAtomicallyRejectedSourceWriteFailure(output)
            ? 'not-persisted'
            : undefined;
        const output2 =
          this.surgicalEditsAvailable && !sourceFailureKind
            ? `${output}\n\n[runtime] This is your ${ordinalSuffix(fails)} consecutive failure of \`${toolName}\` this turn. STOP re-emitting the whole file — retyping the full source keeps corrupting it. Make a TARGETED edit by LINE NUMBER: \`replaceLines({ path, startLine, endLine, content })\` — read the line range off the \`readFile\` gutter and supply ONLY the corrected lines (no \`find\` string to reproduce). If the latest user/check message names a different missing deliverable path, write that exact path next.${this.delegationAvailable ? DELEGATE_HANDOFF_HINT : ''}`
            : `${output}\n\n[runtime] This is your ${ordinalSuffix(fails)} consecutive failure of \`${toolName}\` this turn. STOP retrying fragments or surgical edits.${
                this.delegationAvailable
                  ? DELEGATE_HANDOFF_HINT
                  : ' If the latest user/check message names a different missing deliverable path, write that exact path next. Otherwise read the current file if needed, then call `writeFile` once with the complete corrected source file: full HTML/JS/CSS from the first byte through the final closing tag.'
              }`;
        return {
          output: output2,
          shouldAbort: false,
          count: fails,
          ...(sourceFailureKind ? { sourceFailureKind } : {}),
        };
      }
      return {
        output: `${output}\n\n[runtime] This is your ${ordinalSuffix(fails)} consecutive failure of \`${toolName}\` this turn. STOP retrying \`${toolName}\` — the same call shape will keep failing. Either tell the user the structured call failed and ask them to retry, or accomplish the work a different way.`,
        shouldAbort: false,
        count: fails,
      };
    }
    return { output, shouldAbort: false, count: fails };
  }

  /**
   * Build the user-facing error message thrown when `shouldAbort` is
   * true. Provider name flows in so the message reads "[Mac AI]" /
   * "[Ollama]" / "[llama.cpp]" — same convention as the rest of each
   * provider's error surface.
   */
  static buildAbortMessage(opts: {
    providerLabel: string;
    toolName: string;
    count: number;
    /** See {@link ToolFailureTrackerOpts.surgicalEditsAvailable}. */
    surgicalEditsAvailable?: boolean;
    /** See {@link ToolFailureTrackerOpts.delegationAvailable}. */
    delegationAvailable?: boolean;
    /** See {@link ToolFailureResult.sourceFailureKind}. */
    sourceFailureKind?: 'truncated' | 'not-persisted';
  }): string {
    if (isSourceEditFailureTool(opts.toolName)) {
      // Burned the whole budget failing to edit one file — a coordination/
      // coherence limit more nudging won't clear. If the model can delegate,
      // that's the move (a bigger model lands the edit); only fall back to
      // edit-tool advice when there's no one to hand off to.
      if (opts.delegationAvailable) {
        return `[${opts.providerLabel}] aborting — \`${opts.toolName}\` failed ${opts.count} times in a row this turn. You've shown you can't land this edit. STOP editing this file yourself and hand it to a more capable model: \`delegate_meester\` (or \`delegate_voorman\`), naming the file and the exact change needed.`;
      }
      if (opts.surgicalEditsAvailable && !opts.sourceFailureKind) {
        return `[${opts.providerLabel}] aborting — \`${opts.toolName}\` failed ${opts.count} times in a row this turn. Re-emitting the whole file keeps corrupting it. Don't rewrite the entire file — make one targeted \`replaceLines({ path, startLine, endLine, content })\` edit by line number (read the range off the \`readFile\` gutter; supply only the corrected lines). If the latest user/check message names a different missing deliverable path, write that exact path next.`;
      }
      return `[${opts.providerLabel}] aborting — \`${opts.toolName}\` failed ${opts.count} times in a row this turn. Stop emitting source fragments or more surgical edits. If the latest user/check message names a different missing deliverable path, write that exact path next. Otherwise your next attempt must use one complete \`writeFile({ path, content })\` call for the same file, containing the entire corrected source file from first byte through final closing tag.`;
    }
    return `[${opts.providerLabel}] aborting — \`${opts.toolName}\` failed ${opts.count} times in a row this turn. The model couldn't find a working call shape; the tool result history is preserved so you can see what went wrong. Ask the gezel to try a different approach, or report the bug.`;
  }

  /**
   * Plain-language summary for the user-facing failure banner — the
   * counterpart to {@link buildAbortMessage}'s model-facing corrective.
   * No `[provider]` prefix and no "you must call X" imperatives: the user
   * can't act on tool-call advice, so we tell them what happened and what
   * they can do (retry, or move to a stronger model).
   */
  static buildUserMessage(opts: {
    toolName: string;
    count: number;
    delegationAvailable?: boolean;
  }): string {
    if (isSourceEditFailureTool(opts.toolName)) {
      const handoff = opts.delegationAvailable
        ? ' Try sending your message again, or hand the file to a more capable model.'
        : ' Try sending your message again, or switch to a more capable model in Settings.';
      return `The model couldn't apply its file edit after ${opts.count} tries, so the turn was stopped.${handoff}`;
    }
    return `The model's \`${opts.toolName}\` calls failed ${opts.count} times in a row, so the turn was stopped. Try sending your message again.`;
  }

  /**
   * Build the {@link TurnAbortError} to throw — model-facing corrective on
   * `message`, user-facing summary on `userMessage`. Throw sites use this
   * instead of `new Error(buildAbortMessage(...))` so both audiences are
   * carried through to the chat manager's catch.
   */
  static buildAbort(opts: {
    providerLabel: string;
    toolName: string;
    count: number;
    surgicalEditsAvailable?: boolean;
    delegationAvailable?: boolean;
    sourceFailureKind?: 'truncated' | 'not-persisted';
  }): TurnAbortError {
    return new TurnAbortError(
      ToolFailureTracker.buildAbortMessage(opts),
      ToolFailureTracker.buildUserMessage(opts),
    );
  }
}

function isSourceEditFailureTool(toolName: string): boolean {
  return toolName === 'writeFile' || toolName === 'replaceInFile' || toolName === 'replaceLines';
}

function isFailureOutput(output: string): boolean {
  const trimmed = output.trimStart();
  return (
    /^ERROR:/i.test(trimmed) ||
    /^[\w.-]+\s+was\s+rejected\b/i.test(trimmed) ||
    /^Write failed:/i.test(trimmed) ||
    /^Tool call failed:/i.test(trimmed) ||
    isDraftPlanGateFailure('', trimmed)
  );
}

function isDraftPlanGateFailure(toolName: string, output: string): boolean {
  return (
    (toolName === '' || toolName === 'set_task_status') &&
    /^Cannot change draft task\b/i.test(output.trimStart()) &&
    /\bset_step_deliverable\b/i.test(output)
  );
}

/**
 * One-line steer to hand a repeatedly-failing file edit to a more capable
 * model. Used by both the soft nudge and the hard abort when delegation
 * tools are on the roster.
 */
const DELEGATE_HANDOFF_HINT =
  ' If edits keep failing, this file is beyond what you can reliably edit — STOP and hand it to a more capable model: `delegate_meester` (or `delegate_voorman`), naming the file and the exact change needed.';

function isTruncatedSourceWriteFailure(output: string): boolean {
  return /content looks truncated|final HTML tag is incomplete|<script>`? tag is opened but not closed|starts as full HTML but ends before|complete file contents in one tool call/i.test(
    output,
  );
}

function isAtomicallyRejectedSourceWriteFailure(output: string): boolean {
  return /THE FILE WAS NOT WRITTEN|no bytes from this call were persisted|rejected atomically/i.test(
    output,
  );
}

/**
 * A `write_artifact` refusal triggered by a pre-existing workspace file at
 * the same path — the MCP server's `Refusing write_artifact("…") because a
 * workspace … already exists at that path` guard. Detected on the output
 * text (prefixed `ERROR:` by the bridge), since that's all the tracker
 * sees. An identical retry can never clear it, so it gets the
 * `ARTIFACT_COLLISION_ABORT_AT` fast path rather than the generic budget.
 */
function isUnrecoverableArtifactCollision(output: string): boolean {
  return /Refusing write_artifact\(/i.test(output);
}

/** "1st", "2nd", "3rd", "4th"... for the failure-loop nudge text. */
function ordinalSuffix(n: number): string {
  const rem100 = n % 100;
  const suffix =
    rem100 >= 11 && rem100 <= 13
      ? 'th'
      : n % 10 === 1
        ? 'st'
        : n % 10 === 2
          ? 'nd'
          : n % 10 === 3
            ? 'rd'
            : 'th';
  return `${n}${suffix}`;
}
