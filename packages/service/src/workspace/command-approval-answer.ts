import type { CommandApprovalIntent, QuestionAnswer } from '@bendyline/gezel';
import { hashCommandInvocation, recordApproval } from './command-approvals.js';

/**
 * Translate an answered `command-approval` question into:
 *   - A persisted decision in `command-approvals.json` (approved or declined).
 *   - A synthetic user-message seed describing what happened, so the asking
 *     gezel sees the outcome at the top of its next turn.
 *
 * On approval the seed nudges the model to re-call the tool — it will
 * now succeed. On decline the seed asks it to try a different approach
 * and not retry. Mirrors the `applyNpmInstallApprovals` contract.
 */
export interface ApplyCommandApprovalAnswerOptions {
  home: string;
  projectId: string;
  intent: CommandApprovalIntent;
  answer?: QuestionAnswer;
}

export async function applyCommandApprovalAnswer(
  opts: ApplyCommandApprovalAnswerOptions,
): Promise<string> {
  const verb =
    opts.intent.scope === 'script'
      ? `\`npm run ${opts.intent.name}\``
      : `\`npx ${opts.intent.name}\``;
  // Pin the approval to the exact body/path and argument vector the user
  // saw, so neither can be changed on replay without a fresh prompt.
  const invocationHash = hashCommandInvocation(opts.intent.body, opts.intent.args ?? []);
  const answer = opts.answer;
  if (!answer || answer.declined) {
    await recordApproval(
      opts.home,
      opts.projectId,
      opts.intent.scope,
      opts.intent.name,
      'declined',
      invocationHash,
    );
    return `[command-approval follow-up: user declined ${verb}. Don't retry; try a different approach.]`;
  }
  // choices: ['Approve', 'Decline'] → index 0 approves, 1 declines.
  const choice = answer.selectedChoices?.[0];
  const decision = choice === 0 ? 'approved' : 'declined';
  await recordApproval(
    opts.home,
    opts.projectId,
    opts.intent.scope,
    opts.intent.name,
    decision,
    invocationHash,
  );
  if (decision === 'approved') {
    return `[command-approval follow-up: user approved ${verb}. You may now call the tool again to run it.]`;
  }
  return `[command-approval follow-up: user declined ${verb}. Don't retry; try a different approach.]`;
}
