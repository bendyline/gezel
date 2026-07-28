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
 */

import type { Behavior, PromptCtx } from '../types.js';

export const DERIVE_BY_EXECUTION_GUIDANCE = `

---

## Derived data outputs — execute, don't retype

For a json/csv/tsv deliverable BUILT FROM other files (transform, dedup, convert, aggregate): write a small Node script and execute it — \`derive_file({ script, outputPath })\`, or a script file + \`run_nodejs_script\`. Hand-typing rows loses data. Reports and prose that merely cite data are normal \`write_file\` work.`;

export function deriveByExecutionPrompt(_ctx?: PromptCtx, _config?: undefined): string {
  return DERIVE_BY_EXECUTION_GUIDANCE;
}

export const PromptDeriveByExecution: Behavior = {
  id: 'prompt.derive-by-execution',
  description:
    'Steers models to produce derived data files (json/csv computed from other files) by executing a script (`derive_file` / `run_nodejs_script`) instead of hand-emitting rows through `write_file` — hand-typed derived data loses records. Scope to the local fleet models that do data work; prose/report deliverables are unaffected.',
  promptAppend: deriveByExecutionPrompt,
};
