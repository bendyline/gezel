/**
 * Per-turn same-(name, args) call counter — catches the "stuck in
 * planning" loop that's distinct from the failure-loop case the
 * sibling `ToolFailureTracker` handles.
 *
 * Wild-caught failure shape (Ada on MLX, atari-combat-clone task):
 *   1. read_task_notes("atari-combat-clone/3")
 *   2. list_artifacts(recursive: true)
 *   3. list_dir("src")
 *   4. read_file("package.json")
 *   5. read_file("tsconfig.json")
 *   6. list_packages()
 *   7. write_task_note(...)
 *   8. read_task_notes("atari-combat-clone/3")  ← same as #1
 *   9. read_file("package.json")                  ← same as #4
 *  10. read_file("tsconfig.json")                 ← same as #5
 *  11. read_task_notes("atari-combat-clone/3")  ← same as #1, third time
 *  ... (loops indefinitely emitting "Let me write all these files now"
 *       prose between reads, never actually calls write_file)
 *
 * Why the existing trackers miss this:
 *   - Failures? Every tool call SUCCEEDS — these are healthy reads.
 *     `ToolFailureTracker` only counts ERROR-prefixed outputs.
 *   - Ollama's `detectRepeatCall`? Requires the SAME-args call THREE
 *     TIMES BACK-TO-BACK with nothing in between. Reads here are
 *     interleaved, so the consecutive-only check skips it.
 *
 * What this catches:
 *   Cumulative repeats of the SAME (toolName, args_json) within one
 *   turn. Two thresholds:
 *     - softWarningAt (default 3) — append a `[runtime]` nudge to the
 *       tool's output: "you've called this 3× this turn — you have
 *       what you need; stop re-fetching and act."
 *     - hardAbortAt (default 5) — caller breaks the loop with a
 *       user-facing error.
 *
 * False-positive surface area: legitimate flows that re-read the same
 * file after a write would trigger at 3. The nudge wording handles
 * that: it tells the model "you have what you need" — if the model
 * just changed state and needs to re-read, it can ignore the nudge
 * (the nudge is annotation, not refusal). The hard abort at 5 is the
 * unambiguous "you're stuck" signal — five reads of the same file
 * with the same args, no matter what's interleaved, is not productive.
 *
 * Out of scope: distinguishing read-vs-write tools to give writes a
 * lower threshold. Could be a future refinement; for now the same
 * threshold applies to every tool. ask_user_question has its own
 * dedup at the provider level (one-per-turn) so it never reaches
 * this counter.
 */

import { TurnAbortError } from './turn-abort-error.js';

const SOFT_WARNING_AT_DEFAULT = 3;
const HARD_ABORT_AT_DEFAULT = 5;

/**
 * Per-tool dedup-key normalizers. Some tools accept secondary args
 * (`preferredName`, `description`) that the model rephrases every call —
 * so the raw `JSON.stringify(args)` key differs even though the intent
 * is identical, and the counter never trips.
 *
 * Wild-caught (qwen3.6 27B tankcombat voorman): the voorman
 * called `ensure_gezel` six times in a single turn for the same role,
 * each with a slightly different free-text rationale (the since-removed
 * `whyYouNeed` arg). The cumulative count for each unique blurb stayed
 * at 1, so the hard-abort at 5 never fired and the model burned the turn
 * budget re-creating the same developer instead of chaining to
 * `message_gezel`. `whyYouNeed` is gone now, but the jobTitle-only key
 * still guards against any remaining varying arg (e.g. `preferredName`).
 *
 * Treat those args as decorative for dedup: same `jobTitle` → same key.
 */
const ARG_KEY_NORMALIZERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  ensure_gezel: ({ jobTitle }) => ({ jobTitle }),
  // Rewriting the same workspace file several times in one local-model
  // turn is usually a drift loop, even when the emitted content differs.
  // Wild-caught (qwen3.6 35B MLX bookstore eval): after the
  // real deliverables were present, the model kept overwriting
  // `script.js` with different partial snippets, so same-args repeat
  // detection never fired and the turn ran until the broad 96-loop cap.
  write_file: ({ path }) => ({ path }),
  // Surgical-edit loops have the same failure shape when the model keeps
  // changing the `find` string for one file. Count those by target path.
  replace_in_file: ({ path }) => ({ path }),
};

export interface ToolRepeatTrackerOpts {
  softWarningAt?: number;
  hardAbortAt?: number;
}

export interface ToolRepeatResult {
  /** The tool output, possibly augmented with a soft-warning footer. */
  output: string;
  /** True when the same-(name, args) count hit `hardAbortAt`. */
  shouldAbort: boolean;
  /** Current cumulative count for this exact (toolName, args) pair. */
  count: number;
}

export class ToolRepeatTracker {
  private readonly counts = new Map<string, number>();
  private readonly softWarningAt: number;
  private readonly hardAbortAt: number;

  constructor(opts: ToolRepeatTrackerOpts = {}) {
    this.softWarningAt = opts.softWarningAt ?? SOFT_WARNING_AT_DEFAULT;
    this.hardAbortAt = opts.hardAbortAt ?? HARD_ABORT_AT_DEFAULT;
  }

  /**
   * Record a tool call's args + output. Returns the (possibly-
   * augmented) output the caller should hand back to the model, plus
   * a flag indicating the loop should now abort.
   *
   * `args` is JSON.stringified for the comparison key — V8 preserves
   * insertion order on plain objects, so the same model redrawing the
   * same call produces the same key. Order-different-but-shape-same
   * args are not treated as identical (acceptable false negative).
   */
  recordCall(toolName: string, args: unknown, output: string): ToolRepeatResult {
    const key = `${toolName}:${stringifyArgs(toolName, args, output)}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count >= this.hardAbortAt) {
      return { output, shouldAbort: true, count };
    }
    if (count >= this.softWarningAt) {
      const target = repeatTargetDescription(toolName, args, count);
      if (WRITE_TOOL_NAMES.has(toolName)) {
        return {
          output: `${output}\n\n[runtime] You've called \`${toolName}\` for ${target} this turn. Stop re-writing the same target. If the latest user/check message names a different missing deliverable path, write that exact path next. Otherwise, if this file is correct, validate it or end the turn; if it is still wrong, make one focused edit with \`replace_in_file\` or one complete corrected \`write_file\`, then stop.`,
          shouldAbort: false,
          count,
        };
      }
      return {
        output: `${output}\n\n[runtime] You've called \`${toolName}\` with ${target} this turn. You already have this information from the previous calls — stop re-fetching the same data. Either summarize what you've learned and take action (write a file, send a message, ask the user), or end your turn explaining what's blocking you.`,
        shouldAbort: false,
        count,
      };
    }
    return { output, shouldAbort: false, count };
  }

  /**
   * Build the user-facing error thrown when `shouldAbort` is true.
   * Provider-label flows in for "[Mac AI]" / "[Ollama]" / "[llama.cpp]".
   */
  static buildAbortMessage(opts: {
    providerLabel: string;
    toolName: string;
    args?: unknown;
    count: number;
    /**
     * Registered tool names for this session (typically
     * `bridges.getOpenAITools().map(t => t.name)`). When provided,
     * filters the action-tool suggestion list so the corrective only
     * names tools the gezel actually has — a voorman has no `write_file`
     * and a developer has no `assign_task`. Wild-caught (qwen3.6 27B
     * tankcombat voorman): the abort message suggested
     * `advance_task_phase` (which doesn't exist — the real tool is
     * `advance_task_step`) and `write_file` (not on the voorman's
     * loadout), pointing the model at fabricated tool calls.
     *
     * Omit (or pass undefined) to fall back to the full suggestion
     * list — accepted for older call sites and unit tests.
     */
    registeredTools?: ReadonlySet<string> | readonly string[];
    /**
     * Active craftbook step context, if any. When the session is
     * mid-craftbook, the corrective elevates the step's `onExit`
     * script name as the recommended next call. Without this medium
     * models loop on `read_task_notes` looking for the procedure
     * that's already embedded in the step manifest — the corrective
     * then points them at `write_file` (wrong for a review task) and
     * they fabricate. Wild-caught on the review craftbook spin
     * (gemma4-26B): `read_task_notes` × 5 on a "Load PR
     * context" step whose right action was `run_script({ name:
     * 'pr-context' })`.
     */
    activeStep?: {
      name: string;
      onExitScriptName?: string;
    };
  }): string {
    // The message is consumed twice: (1) the chat layer throws it as
    // the turn's error, the user sees it in the failure banner; (2) it
    // lands on the session record's `lastTurnError`, which is replayed
    // into the gezel's context on the next attempt. Phrase it as a
    // direct corrective TO THE GEZEL — wild-caught Gemma 26B kept
    // calling read_task_notes 14× across 3 trials when the previous
    // wording ("Ask the gezel to summarize…") read as user guidance
    // and didn't change the gezel's behavior on resume.
    const isWriteTool = WRITE_TOOL_NAMES.has(opts.toolName);
    // For write-tool loops, the suggestion list should EXCLUDE the
    // looping tool — telling a model "you already wrote write_artifact
    // 5x, the next action MUST be write_artifact" is the contradiction
    // that caused nemotron-nano's tankcombat run to abort.
    const filteredRegistered = isWriteTool
      ? filterOutTool(opts.registeredTools, opts.toolName)
      : opts.registeredTools;
    const suggestions = filterActionToolSuggestions(filteredRegistered);
    // Ship-code hint only when an obvious file-write tool is actually
    // wired this turn AND we're aborting on a read-loop (not a write
    // loop — in that case the model already wrote, telling it to write
    // again is the contradiction we're trying to avoid).
    const hasWorkspaceWrite = suggestions.includes('write_file');
    const hasArtifactWrite = suggestions.includes('write_artifact');
    const hasRepoIntake = suggestions.includes('fetch_repo') || suggestions.includes('fetch_diff');
    const repeatedCoordinationRead =
      opts.toolName === 'list_gezels' ||
      opts.toolName === 'list_projects' ||
      opts.toolName === 'list_gilde';
    const sourceReadWithoutWorkspaceWrite =
      !isWriteTool &&
      opts.toolName === 'read_file' &&
      !hasWorkspaceWrite &&
      looksLikeSourceFileRead(opts.args);
    const visibleSuggestions = sourceReadWithoutWorkspaceWrite
      ? suggestions.filter((t) => t !== 'write_artifact')
      : suggestions;
    const list = (visibleSuggestions.length > 0 ? visibleSuggestions : suggestions)
      .map((t) => `\`${t}\``)
      .join(', ');
    const shipHint =
      hasWorkspaceWrite && !isWriteTool
        ? ' If the task is to ship source or project files, call `write_file` now with the full file contents — do not narrate the plan first.'
        : sourceReadWithoutWorkspaceWrite
          ? ' You do not have workspace write access in this role, so you cannot create or edit that source file yourself. Hand off to a developer with `message_gezel`/`assign_task`, or ask the user only if no writable specialist is available.'
          : hasArtifactWrite && !isWriteTool
            ? ' If the task is to ship source or project files, do not use `write_artifact`; artifacts are for plans/scratch. Start with a handoff tool or `ask_user_question` if one is available.'
            : '';
    const repoIntakeHint =
      hasRepoIntake && repeatedCoordinationRead
        ? ' If the user asked you to review, analyze, or work with a remote repository, call `fetch_repo` first (or `fetch_diff` for a PR/diff) so the project workspace contains real source files before you recruit a reviewer.'
        : '';
    // Craftbook-step hint takes precedence when applicable — the right
    // next action is in the step manifest, not in another task-notes
    // read.
    const stepHint = opts.activeStep
      ? opts.activeStep.onExitScriptName
        ? ` You are mid-craftbook step **${opts.activeStep.name}** — the right next call is \`run_script({ name: "${opts.activeStep.onExitScriptName}" })\`. The script is already installed in the project.`
        : ` You are mid-craftbook step **${opts.activeStep.name}** — re-read the step procedure in your system prompt and call the tool it names. Do NOT call \`read_task_notes\` again; the procedure is in the prompt, not the notes.`
      : '';
    // Branch the corrective on tool class. Read loops are "you already
    // know enough; stop re-reading"; write loops are "the file is
    // already written; do something DIFFERENT next." Same-args repeats
    // of a write tool mean the model rewrote the same content — the
    // file on disk already matches what it would write, so the
    // semantically-meaningful next move is to validate, hand off, ask,
    // or accept and stop.
    if (isSourceEditToolLoop(opts.toolName, opts.args)) {
      return `[${opts.providerLabel}] aborting — \`${opts.toolName}\` was called for ${repeatTargetDescription(opts.toolName, opts.args, opts.count)} this turn without making progress. Stop emitting fragments or more surgical edits for this file. Re-read the latest user/check message before choosing the next tool. If it names a different missing deliverable path, your next message MUST start with \`write_file({ path, content })\` for that exact path. Otherwise, your next message MUST start with one complete \`write_file({ path, content })\` call for this same path, containing the entire corrected source file from first byte through final closing tag. If you cannot do that, ask the user a question instead.`;
    }
    if (isWriteTool) {
      return `[${opts.providerLabel}] aborting — \`${opts.toolName}\` was called for ${repeatTargetDescription(opts.toolName, opts.args, opts.count)} this turn without making progress. The file is already written. Stop re-writing. Pick a DIFFERENT next action: validate what you wrote (read it back once, run it, or ask), hand off (\`message_gezel\`, \`assign_task\`, \`advance_task_step\`), accept and end the turn, or ask the user a question. Your next message MUST start with a single action-tool call from this set: ${list}.${stepHint}`;
    }
    return `[${opts.providerLabel}] aborting — \`${opts.toolName}\` was called with ${repeatTargetDescription(opts.toolName, opts.args, opts.count)} this turn without making progress. You already have what you need from \`${opts.toolName}\`. Stop re-reading. Your next message MUST start with a single action-tool call (${list}).${stepHint}${repoIntakeHint}${shipHint}`;
  }

  /**
   * Plain-language summary for the user-facing failure banner — the
   * counterpart to {@link buildAbortMessage}'s model-facing corrective.
   * The model-facing text names tools and demands a specific next call;
   * the user just needs "it got stuck repeating itself" and a nudge to
   * retry or rephrase.
   */
  static buildUserMessage(): string {
    return 'The model got stuck repeating the same action without making progress, so the turn was stopped. Try sending your message again, or rephrase your request.';
  }

  /**
   * Build the {@link TurnAbortError} to throw — model-facing corrective on
   * `message`, user-facing summary on `userMessage`. See
   * {@link ToolFailureTracker.buildAbort} for the rationale.
   */
  static buildAbort(
    opts: Parameters<typeof ToolRepeatTracker.buildAbortMessage>[0],
  ): TurnAbortError {
    return new TurnAbortError(
      ToolRepeatTracker.buildAbortMessage(opts),
      ToolRepeatTracker.buildUserMessage(),
    );
  }
}

function isSourceEditToolLoop(toolName: string, args: unknown): boolean {
  if (toolName !== 'write_file' && toolName !== 'replace_in_file') return false;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const path = (args as Record<string, unknown>).path;
  return typeof path === 'string' && /\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md)$/i.test(path);
}

/**
 * Tools that mutate state — for these, a same-args loop means "the
 * file already matches what you'd write again" rather than "you have
 * the data you need." The abort message has a different shape.
 */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'write_artifact',
  'append_to_file',
  'replace_in_file',
  'apply_patch',
  'insert_at_marker',
  'rename',
  'make_dir',
  'delete_path',
  'write_document',
  'write_task_note',
]);

function filterOutTool(
  registered: ReadonlySet<string> | readonly string[] | undefined,
  toolName: string,
): ReadonlySet<string> | readonly string[] | undefined {
  if (!registered) return registered;
  if (registered instanceof Set) {
    const out = new Set<string>();
    for (const t of registered) if (t !== toolName) out.add(t);
    return out;
  }
  return (registered as readonly string[]).filter((t) => t !== toolName);
}

/**
 * Curated list of "action" tools — the ones that actually move a
 * project forward (ship a file, hand off, finish, ask). Kept in priority
 * order so the message reads as a recommendation rather than an
 * alphabetical dump. When `registered` is provided, drop anything not
 * actually wired — prevents the corrective from pointing the gezel at
 * a tool name they don't have.
 *
 * Notable: `advance_task_phase` is intentionally absent — that name was
 * in the previous hardcoded list but the real tool has always been
 * `advance_task_step`. The old name was load-bearing for confusion.
 */
function filterActionToolSuggestions(
  registered?: ReadonlySet<string> | readonly string[],
): string[] {
  // Order signals priority: file-writes first (the "ship code" arc),
  // then craftbook-procedure tools (run_script, github_*), then task
  // mechanics, then escape valves (ask). Previously this list was
  // file-write + task-mechanics only — which is exactly wrong inside a
  // craftbook step whose next action is `run_script` or `github_pr_*`,
  // and pointed gemma4-26B at fabricated `write_file` calls when it
  // should have been running the step's onExit script. Wild-caught on
  // the review-craftbook spin: `read_task_notes` × 5 because the
  // gezel had no good action-tool candidates surfaced.
  const candidates = [
    'fetch_repo',
    'fetch_diff',
    'start_project',
    'start_job',
    'ensure_gezel',
    'write_artifact',
    'write_file',
    'run_script',
    'github_pr_list',
    'github_pr_view',
    'github_pr_diff',
    'github_pr_comment',
    'run_git',
    'delegate_developer',
    'delegate_builder',
    'delegate_reviewer',
    'delegate_researcher',
    'delegate_designer',
    'delegate_planner',
    'delegate_voorman',
    'message_gezel',
    'assign_task',
    'advance_task_step',
    'set_task_status',
    'ask_user_question',
  ];
  if (!registered) return candidates;
  const set = registered instanceof Set ? registered : new Set(registered);
  const filtered = candidates.filter((t) => set.has(t));
  // Defensive: never collapse to zero — if the registered list is
  // empty or the candidates all happen to be missing, fall back to the
  // full list so the user at least sees the intent.
  return filtered.length > 0 ? filtered : candidates;
}

function stringifyArgs(toolName: string, args: unknown, output: string): string {
  if (args == null) return '{}';
  // An atomically rejected write_file draft never reached disk. Count a
  // repeated *identical* rejected draft, but do not collapse different
  // syntax-correction attempts to the path-only key used for persisted
  // overwrites. ToolFailureTracker still owns repeated failures; spending
  // the successful-write repeat budget here can abort a repair immediately
  // after the first valid source finally lands.
  const atomicallyRejectedWrite =
    toolName === 'write_file' &&
    /(?:write is rejected atomically|THE FILE WAS NOT WRITTEN)/i.test(output);
  const normalizer = atomicallyRejectedWrite ? undefined : ARG_KEY_NORMALIZERS[toolName];
  // Only normalize when the args shape is the expected plain object;
  // a stray string/array falls back to the raw `JSON.stringify` path.
  const effective =
    normalizer && typeof args === 'object' && !Array.isArray(args)
      ? normalizer(args as Record<string, unknown>)
      : args;
  try {
    return JSON.stringify(effective);
  } catch {
    return String(effective);
  }
}

function repeatTargetDescription(toolName: string, args: unknown, count: number): string {
  if (
    (toolName === 'write_file' || toolName === 'replace_in_file') &&
    args &&
    typeof args === 'object' &&
    !Array.isArray(args) &&
    typeof (args as Record<string, unknown>).path === 'string'
  ) {
    return `the same path \`${(args as Record<string, unknown>).path}\` ${count} times`;
  }
  return `these exact arguments ${count} times`;
}

function looksLikeSourceFileRead(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const path = (args as Record<string, unknown>).path;
  if (typeof path !== 'string') return false;
  return /\.(?:html?|css|mjs|cjs|jsx?|tsx?|json|ya?ml|toml|xml|vue|svelte|py|rb|php|go|rs|java|kt|cs|cpp|c|h|hpp|sh|ps1|sql)$/i.test(
    path.trim(),
  );
}
