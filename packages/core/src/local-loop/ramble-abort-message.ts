/**
 * The corrective a ramble abort hands back to the model.
 *
 * This string is not a log line — it is re-prompted to the gezel as the
 * next thing it reads, so every tool it names must be one the turn
 * actually wired, in the drawer the step actually writes to.
 *
 * The original copy was a static literal shared by all three local
 * providers. It hardcoded `write_file`, offered "a handoff tool" as the
 * no-workspace-write escape, and closed with "Do not save source files
 * with `write_artifact`; artifacts are for plans/scratch." On a
 * read-only project running a review craftbook that is three wrong
 * answers and one forbidden right one: `write_file` was not on the
 * roster, no delegation tool was wired, and `write_artifact` — the
 * step's only deliverable tool — was the thing being ruled out.
 *
 * Wild-caught (qwen3.8-27b-q4, PR-review batch step on a writes-off
 * project): of the four routes offered, only `ask_user_question`
 * existed, and it was the wrong action.
 *
 * Same failure class as the cap-truncation steer in
 * [local-tool-call-salvage.ts](./local-tool-call-salvage.ts) and the
 * McKinley Park incident in ADR 0001: a runtime hint may only name
 * tools the turn actually wired.
 */

export interface RambleAbortMessageOpts {
  /** Provider tag the user sees, e.g. `[Mac AI]` / `[llama-cpp]`. */
  providerLabel: string;
  /** Characters of prose buffered before the watchdog fired. */
  charCount: number;
  /** Post-allowlist tool names wired for this turn. */
  knownToolNames: ReadonlySet<string>;
  /** Exact deliverable path from the active craftbook step, if any. */
  deliverableFile?: string;
  /** True when that deliverable lives in the artifacts drawer. */
  deliverableIsArtifact?: boolean;
}

/**
 * The invariant head. `describeDelegateFailureForAsker` and
 * `manager.ts`'s corrective classifier both pattern-match on this
 * wording — keep "emitted N characters of prose this turn" and "Stop
 * planning." intact when editing.
 */
function head(providerLabel: string, charCount: number): string {
  const preamble =
    'Stop planning. Your next message must START with a single tool call — or, if the work is genuinely finished and nothing is left to do, be ONE short sentence saying so and nothing else.';
  return `${providerLabel} aborting — the gezel emitted ${charCount} characters of prose this turn without calling any action tool. ${preamble}`;
}

/**
 * The one concrete next call, chosen from what is actually on the
 * roster. Ordered most- to least-specific: a named step deliverable
 * beats a generic write, a generic write beats a handoff, and a handoff
 * beats asking the user. The final fallback names no tool at all rather
 * than inventing one.
 */
function route(opts: RambleAbortMessageOpts): string {
  const { knownToolNames: known, deliverableFile, deliverableIsArtifact } = opts;
  const hasFileWrite = known.has('write_file');
  const hasArtifactWrite = known.has('write_artifact');

  if (deliverableFile) {
    // Honor the step's own drawer first; fall back to whichever writer
    // IS wired rather than naming one that isn't.
    const preferred = deliverableIsArtifact ? 'write_artifact' : 'write_file';
    const alternate = deliverableIsArtifact ? 'write_file' : 'write_artifact';
    const tool = known.has(preferred) ? preferred : known.has(alternate) ? alternate : null;
    if (tool) {
      return `This step's deliverable is \`${deliverableFile}\` — call \`${tool}\` NOW with its full contents. No preamble, no plan, no summary of what you would write.`;
    }
  }

  if (hasFileWrite) {
    const artifactCaveat = hasArtifactWrite
      ? ' Do not save source or project files with `write_artifact`; artifacts are for plans/scratch.'
      : '';
    return `If you are shipping source or project files, call \`write_file\` NOW with the full file contents — no preamble, no plan.${artifactCaveat}`;
  }

  if (hasArtifactWrite) {
    // No workspace-write surface. The artifacts drawer is not a
    // consolation prize here — it is where this session's work belongs,
    // so say so plainly instead of warning the model off it.
    return 'This session cannot write workspace files, so `write_artifact` is where your work belongs — call it NOW with the full contents of what you were producing. No preamble, no plan.';
  }

  const delegation = [...known].find((n) => n.startsWith('delegate_'));
  if (delegation) {
    return `You have no write tool this turn — hand the work off with \`${delegation}\` NOW, carrying the full contents you were about to describe.`;
  }

  if (known.has('ask_user_question')) {
    return 'You have no write or handoff tool this turn. If you need a decision to proceed, call `ask_user_question` NOW; otherwise say in one sentence what you cannot do.';
  }

  // Nothing actionable is wired. Naming a tool here would just trip the
  // validate-ids wrapper and cost another turn.
  return 'No write or handoff tool is wired this turn — say in one sentence what you cannot do.';
}

export function buildRambleAbortMessage(opts: RambleAbortMessageOpts): string {
  return `${head(opts.providerLabel, opts.charCount)} ${route(opts)}`;
}
