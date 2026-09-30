/**
 * `prompt.source-files-read-only` — stop a model from writing into the files
 * it was given to READ, and make it name the target before a positional edit.
 *
 * The failure this exists for is quiet and expensive: a positional edit aimed
 * at the deliverable lands on an input instead, and nothing refuses it. Wild-
 * caught on gemma4-e4b / incident-postmortem (2026-08-02 core suite): the
 * model had one deliverable (`postmortem.md`, one `write_file`) and a
 * five-file read-only evidence pack, then issued a `replace_lines` that
 * overwrote line 21 of `evidence/timeline.md` —
 *
 *     - **14:41** Mira Chen joins as incident commander.
 *   → - **14:54** error_rate drops below 1%. p99 latency recovers to 238ms.
 *
 * The replacement text was accurate and correctly cited; only the destination
 * was wrong. It was composing its own Timeline section and patched the source
 * it was quoting. Worse, the clobbered line was itself a graded fact, so the
 * model destroyed the evidence it needed to cite and failed two grounding
 * checks it had otherwise passed.
 *
 * Two rules, because the failure has two halves: the model does not treat
 * "given to me" as "not mine to change" (rule 1), and it does not re-check
 * the path on a tool whose arguments are line numbers rather than a filename
 * it just typed (rule 2). Positional edits are the exposed surface precisely
 * because `prompt.prefer-writefile-edits` steers small models toward them.
 *
 * This is guidance, not enforcement — a model can still ignore it. The
 * durable fix is refusing the write at the tool layer; this behavior is the
 * cheap half that ships without touching the MCP surface.
 */

import type { Behavior, PromptCtx } from '../types.js';

export const SOURCE_FILES_READ_ONLY_GUIDANCE = `

---

## Source files are read-only

Files you were given to read — evidence, source data, fixtures, anything you did not create — are inputs. Never \`write_file\`, \`append_to_file\`, \`replace_in_file\`, or \`replace_lines\` on them. Quote them into your own deliverable instead; editing an input destroys the record you are citing.

Before any \`replace_lines\` or \`replace_in_file\`, state the path you are about to change and confirm it is a file you were asked to produce.`;

export function sourceFilesReadOnlyPrompt(_ctx?: PromptCtx, _config?: undefined): string {
  return SOURCE_FILES_READ_ONLY_GUIDANCE;
}

export const PromptSourceFilesReadOnly: Behavior = {
  id: 'prompt.source-files-read-only',
  description:
    'Tells the model that files it was given to read (evidence, source data, fixtures) are inputs it must never write to, and to name the target path before a positional edit. Counters a `replace_lines` aimed at the deliverable landing on a read-only source. Scope to models that do evidence-grounded or data-transform work.',
  promptAppend: sourceFilesReadOnlyPrompt,
};
