export const TRUSTED_CHECK_RUNNER_ENV = 'GEZEL_EVAL_TRUSTED_CHECK_RUNNER';

/**
 * Eval-only treatment switch. Production behavior is the standard
 * `checkWorkspaceScript` gate; this flag lets scenario matrices compare an
 * otherwise-identical baseline and treatment without product-wide rollout.
 */
export function trustedCheckRunnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TRUSTED_CHECK_RUNNER_ENV]?.trim() === '1';
}

export const TRUSTED_RUNNER_KICKOFF =
  'A caller-pinned trusted checker will run automatically when your turn ends. Do not edit or delete the checker. If it rejects the implementation, use its named failures to make a focused source correction; the independent scenario grader still makes the final decision.';
