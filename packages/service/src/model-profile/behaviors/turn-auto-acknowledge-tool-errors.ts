/**
 * `turn.auto-acknowledge-tool-errors` — fires a re-prompt when
 * at least one unresolved tool call this turn returned an error AND the
 * assistant's text doesn't acknowledge the failure. The pattern
 * this catches: the model calls `create_project`, the call fails
 * (Zod rejection, fabricated ID, etc.), the bridge returns the
 * error string, the model's next bubble cheerfully claims "I have
 * created the project for you" — the failure invisible to both
 * model and user. Wild-caught on Gemma 4 26B at the end of the
 * Cosima / Space Invaders bundle.
 *
 * Decision: re-prompt with a corrective note. The detector
 * returns a {@link NudgeVerdict} with `promptForNextTurn` set to
 * an instruction that names the failed tool(s) and asks the model
 * to either retry with a fix or tell the user the action didn't
 * happen.
 *
 * Acknowledgment heuristic: the assistant text must mention any
 * of the standard failure-words ("error", "failed", "couldn't",
 * "didn't work", "rejected", "not yet", "wasn't able to"). Match
 * is case-insensitive. If none appear, the model is presumed to
 * have ignored the failure and the verdict fires.
 *
 * Migrated from the planning conversation; no legacy code to
 * cite. Opt-in only on Gemma manifests for now — the pattern is
 * specific enough to that family that universal application
 * would over-fire on cloud models that legitimately recover.
 */

import type { Behavior, NudgeVerdict, TurnCtx } from '../types.js';

const ACKNOWLEDGMENT_PATTERN =
  /\b(?:error(?:ed|s)?|failed?|couldn['’]t|did(?:n['’]t| not)\s+work|rejected|not\s+yet|wasn['’]t\s+able|unable\s+to|cannot|can['’]t\b|fabric)/i;

/**
 * Workspace tools that can supersede one another when they successfully
 * mutate the same file later in the turn. Keep this deliberately narrower
 * than every path-bearing tool: a successful read or validation does not
 * repair a failed write.
 */
const WORKSPACE_FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'writeFile',
  'appendToFile',
  'replaceInFile',
  'replaceLines',
  'applyPatch',
  'insertAtMarker',
]);

function buildRePrompt(failedToolNames: readonly string[]): string {
  const list =
    failedToolNames.length > 0 ? failedToolNames.map((n) => `\`${n}\``).join(', ') : 'a tool call';
  return [
    `Your previous turn used ${list} and the call(s) returned an error.`,
    'Your reply did not acknowledge the failure — that means the user thinks the action succeeded when it did not.',
    'Either:',
    '  1. Retry with corrected arguments (read the error message — it tells you what was wrong), OR',
    '  2. Tell the user plainly that the action did not happen and why, then ask what they want to do next.',
    'Do not narrate success when no successful tool call landed.',
  ].join('\n');
}

function buildDraftPlanGateRePrompt(): string {
  return [
    'Your previous `set_task_status` call was rejected because the target is a draft plan with ungated build steps.',
    'That error is actionable, not a stopping condition: use the exact `set_step_deliverable(...)` calls listed in the tool error.',
    'Your next assistant action must be `set_step_deliverable({ task: "<draft ref>", stepId: "<listed step id>", path: "index.html", kind: "html-page" })` for one listed ungated step.',
    'If several ungated steps are listed, call `set_step_deliverable` once per step. Do not call `set_task_status`, `activate_task`, or narrate completion until those calls return success.',
  ].join('\n');
}

function detect(ctx: TurnCtx): NudgeVerdict | null {
  const failed = ctx.drained.filter(
    (call, index, calls) =>
      !call.success &&
      !isRecoverableSavedDraftToolCall(call) &&
      !isSupersededByLaterSuccess(call, index, calls),
  );
  if (failed.length === 0) return null;
  if (
    failed.some(isDraftPlanGateFailure) &&
    !ctx.drained.some((d) => d.name === 'set_step_deliverable' && d.success)
  ) {
    return {
      reason: '`set_task_status` hit a draft-plan gate and still needs `set_step_deliverable`',
      promptForNextTurn: buildDraftPlanGateRePrompt(),
    };
  }
  if (ACKNOWLEDGMENT_PATTERN.test(ctx.assistantContent)) return null;
  const failedNames = failed.map((d) => d.name);
  return {
    reason: `tool(s) [${failedNames.join(', ')}] errored but the reply did not acknowledge the failure`,
    promptForNextTurn: buildRePrompt(failedNames),
  };
}

function isSupersededByLaterSuccess(
  failed: TurnCtx['drained'][number],
  failedIndex: number,
  calls: TurnCtx['drained'],
): boolean {
  return calls.slice(failedIndex + 1).some((later) => {
    if (!later.success) return false;

    // A later successful retry of the same non-file tool resolves the earlier
    // call. File tools also need a matching target; two writes to different
    // files are unrelated even when they use the same MCP tool.
    if (later.name === failed.name && !WORKSPACE_FILE_MUTATION_TOOLS.has(failed.name)) {
      return true;
    }

    // Surgical edit tools and full-file writes are interchangeable repair
    // mechanisms only when both calls target the same workspace file.
    if (
      !WORKSPACE_FILE_MUTATION_TOOLS.has(failed.name) ||
      !WORKSPACE_FILE_MUTATION_TOOLS.has(later.name)
    ) {
      return false;
    }
    const failedPath = normalizeWorkspacePath(failed.path);
    const laterPath = normalizeWorkspacePath(later.path);
    return failedPath !== null && laterPath !== null && failedPath === laterPath;
  });
}

function normalizeWorkspacePath(path: string | undefined): string | null {
  if (typeof path !== 'string') return null;
  const normalized = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^workspace\//i, '')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
  return normalized.length > 0 ? normalized : null;
}

function isRecoverableSavedDraftToolCall(call: TurnCtx['drained'][number]): boolean {
  return (
    call.name === 'writeFile' &&
    call.success === false &&
    typeof call.errorMessage === 'string' &&
    /Invalid first draft\s+\S+\s+was saved anyway so you can continue with/i.test(call.errorMessage)
  );
}

function isDraftPlanGateFailure(call: TurnCtx['drained'][number]): boolean {
  return (
    call.name === 'set_task_status' &&
    call.success === false &&
    typeof call.errorMessage === 'string' &&
    /^Cannot change draft task\b/i.test(call.errorMessage.trimStart()) &&
    /\bset_step_deliverable\b/i.test(call.errorMessage)
  );
}

export const TurnAutoAcknowledgeToolErrors: Behavior = {
  id: 'turn.auto-acknowledge-tool-errors',
  description:
    'Re-prompts when ≥1 unresolved tool call this turn errored AND the assistant text does not acknowledge the failure. Catches Gemma 4 26B claiming "I have created the project" after `create_project` rejected with a Zod error.',
  postTurnDetector: (ctx) => detect(ctx),
};
