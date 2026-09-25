import { bareToolName } from './tool-names.ts';
import type { EvalRepairActionSnapshot } from './types.ts';

/**
 * Tools whose successful call means the model actually changed something.
 *
 * Matched through `bareToolName`, so every spelling of the same capability
 * lands here: the plain gezel-mcp name a local engine emits, the
 * `mcp__gezel__` namespacing CLI providers apply, and the CLI providers'
 * own built-in editors. Legacy camelCase spellings are kept for scoring
 * pre-rename run dirs.
 *
 * Bare-name-only matching made this counter read ZERO for the whole of
 * every anthropic-cli trial, which is the second arm of
 * `advanceEscalationState`: with the failure text frozen too, the
 * escalation ladder could never leave attempt 1, so the harness delivered
 * exactly ONE repair message and then sat silent until the retry-loop
 * killed the trial — reporting "(retry-loop nudge was sent and ignored)"
 * for a ladder that never escalated. Wild-caught on
 * craftbook-author-fanout x claude-sonnet-4-6: one nudge at 19:28:06,
 * 17 minutes of real work (9 `mcp__gezel__append_to_file`, 5 `Write`),
 * no second message, killed at 19:45:22.
 */
const COMPLETED_REPAIR_MUTATION_TOOLS = new Set([
  'write_file',
  'write_artifact',
  'replace_in_file',
  'replace_lines',
  'apply_patch',
  'append_to_file',
  'insert_at_marker',
  'copy_artifact_to_workspace',
  'writefile',
  'replaceinfile',
  'replacelines',
  'applypatch',
  'appendtofile',
  'insertatmarker',
  // CLI providers' built-in editors — Claude has no gezel-mcp `write_file`.
  'write',
  'edit',
  'multiedit',
  'notebookedit',
]);

/**
 * Count committed assistant turns that completed at least one successful
 * file mutation. A turn is the unit (rather than each tool call) because one
 * repair response may try a failed surgical edit and then land a successful
 * rewrite; that is one model attempt, not two. In-flight calls are absent
 * from `session.messages` until the turn commits, which makes this safe as a
 * bounded-repair action token.
 *
 * Kept apart from runner.ts so the mobile grader can use it without loading
 * the desktop harness, which needs workspace packages the iOS job never builds.
 */
export function completedRepairActionSnapshot(
  session: {
    messages: Array<{
      role: 'user' | 'assistant';
      toolCalls?: Array<{ name: string; success: boolean }>;
    }>;
  },
  inflight = false,
): EvalRepairActionSnapshot {
  return {
    completedMutationTurns: session.messages.filter(
      (message) =>
        message.role === 'assistant' &&
        message.toolCalls?.some(
          (call) => call.success && COMPLETED_REPAIR_MUTATION_TOOLS.has(bareToolName(call.name)),
        ),
    ).length,
    completedTurns: session.messages.filter((message) => message.role === 'assistant').length,
    inflight,
  };
}
