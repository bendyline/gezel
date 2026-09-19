import type { StepGateOutcome } from './step-gate.js';

export function formatGateScriptDiagnostics(runs: StepGateOutcome['runs']): string {
  return runs
    .filter((run) => run.error || run.logsTail)
    .map((run) => {
      const lines = [`- Script: \`${run.scriptName}\``];
      if (run.runId) lines.push(`  - Run ID: \`${run.runId}\``);
      if (run.error) lines.push(`  - Error: ${run.error}`);
      if (run.logsTail) lines.push(`  - Log tail:\n\n    \`\`\`\n${run.logsTail}\n    \`\`\``);
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * A step completion refused by the task's state (not effectively active, or
 * not the active step) rather than by its gate. Typed so the HTTP layer
 * answers 409: the bare throw came back as `internal_error` and a model
 * retried the same completion against the same 500 (codemod-sweep, 2026-09-18).
 */
export class StepCompletionBlockedError extends Error {
  readonly code = 'step_completion_blocked' as const;
  constructor(
    message: string,
    readonly reason: 'task_not_active' | 'step_not_active',
  ) {
    super(message);
    this.name = 'StepCompletionBlockedError';
  }
}
