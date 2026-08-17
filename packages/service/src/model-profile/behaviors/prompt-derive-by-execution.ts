/**
 * `prompt.derive-by-execution` — steer local models to produce derived
 * data outputs (json/csv built FROM other files) by writing and running a
 * small script instead of hand-emitting the rows through `write_file`.
 *
 * Token emission is the wrong transport for precision artifacts: the
 * The evidence is gemma inventing row IDs, qwen keeping a wrong
 * dedupe date across three rewrites, and DS4 spending 18 minutes
 * hand-serializing a 7.2 KB JSON that still failed — while the same
 * transform expressed as a script passed 10/10 at 10% of the budget.
 * The structural wiring (deliverable kinds, the data gate floor, the
 * `derive_file` tool) makes the pattern available; this behavior is the
 * standing steer for the model tiers that reach for `write_file` by
 * habit. Placed LATE in ALL_BEHAVIORS (after prefer-writefile-edits)
 * so it wins on recency for this one file class.
 *
 * Deliberately keyed on what the OUTPUT is, not the task wording:
 * reports and prose that merely cite data are normal write_file work.
 *
 * Gated on the roster: the block names the execution tools actually wired
 * this turn and goes silent when none are. A steer whose remedy is absent
 * is worse than no steer — it tells the model its instinct is wrong without
 * giving it anything to do instead.
 */

import type { Behavior, PromptCtx } from '../types.js';

/** Execution tools this steer can actually point at, in preference order. */
const EXECUTION_TOOLS = ['derive_file', 'run_nodejs_script'] as const;

function guidance(execution: readonly string[], writeTool: string | null): string {
  const how =
    execution.length === 2
      ? `\`${execution[0]}({ script, outputPath })\`, or a script file + \`${execution[1]}\``
      : execution[0] === 'derive_file'
        ? '`derive_file({ script, outputPath })`'
        : `a script file + \`${execution[0]}\``;
  const carveOut = writeTool
    ? ` Reports and prose that merely cite data are normal \`${writeTool}\` work.`
    : '';
  return `

---

## Derived data outputs — execute, don't retype

For a json/csv/tsv deliverable BUILT FROM other files (transform, dedup, convert, aggregate): write a small Node script and execute it — ${how}. Hand-typing rows loses data.${carveOut}`;
}

/**
 * The full-roster wording, kept as an export because tests and the prompt
 * contract matrix assert against it.
 */
export const DERIVE_BY_EXECUTION_GUIDANCE = guidance(EXECUTION_TOOLS, 'write_file');

export function deriveByExecutionPrompt(ctx?: PromptCtx, _config?: undefined): string | null {
  // No roster (older callers / synthetic contexts) → the standing wording.
  if (!ctx?.availableToolNames) return DERIVE_BY_EXECUTION_GUIDANCE;
  const execution = EXECUTION_TOOLS.filter((tool) => ctx.availableToolNames.has(tool));
  // Steering a session with no execution tool toward "execute, don't retype"
  // leaves it with a diagnosis and no remedy. Wild-caught on a craftbook step
  // whose 25 KB derived JSON exceeded the turn's output cap: the block named
  // `derive_file` and `run_nodejs_script`, neither was wired, and the model
  // fell back to hand-transcribing 509 paths — exactly what this steer exists
  // to prevent. Silence is the honest output; the step's own instructions and
  // the cap-truncation hint carry the recovery from there.
  if (execution.length === 0) return null;
  const writeTool = ['write_file', 'write_artifact'].find((tool) =>
    ctx.availableToolNames.has(tool),
  );
  return guidance(execution, writeTool ?? null);
}

export const PromptDeriveByExecution: Behavior = {
  id: 'prompt.derive-by-execution',
  description:
    'Steers models to produce derived data files (json/csv computed from other files) by executing a script (`derive_file` / `run_nodejs_script`) instead of hand-emitting rows through `write_file` — hand-typed derived data loses records. Scope to the local fleet models that do data work; prose/report deliverables are unaffected.',
  promptAppend: deriveByExecutionPrompt,
};
