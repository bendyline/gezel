import { canonicalToolName } from '../tools/tool-names.js';
import type { ActiveCraftbookStep, TerminalToolPolicy } from './provider-contract.js';

export const TERMINAL_ACTION_SKIPPED_OUTPUT =
  '[runtime] Skipped because an earlier terminal action in this tool batch succeeded. Ownership has transferred; end the turn without further side effects.';

/**
 * Runtime-owned terminal tools. These are terminal because their successful
 * side effect transfers ownership away from the current model turn, not
 * because a particular project profile opted into a closing policy.
 *
 * `advance_task_step` is the important case: once it activates the successor
 * step, the old step's session is stale. Asking that model for another
 * generation lets it keep writing after handoff (and, with prose salvage,
 * overwrite the deliverable that just cleared the gate).
 */
const BUILTIN_TERMINAL_TOOLS = new Set(['advance_task_step']);

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\\/g, '/');
}

function compactClosing(text: string, fallback: string, maxChars: number): string {
  const compact = (text.trim() || fallback).replace(/\s+/g, ' ');
  const max = Math.max(1, maxChars);
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

/**
 * Return the one-line reply for a successful terminal action tool.
 * Errors never terminate: their detailed output must go back through the
 * ordinary tool loop so the model can correct its arguments.
 */
export function terminalToolClosingText(
  policy: TerminalToolPolicy | undefined,
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): string | null {
  if (output.trimStart().startsWith('ERROR:')) return null;
  if (BUILTIN_TERMINAL_TOOLS.has(toolName)) {
    // Only the first paragraph is for a person; the rest (refs, the active
    // step, handoff instructions) is for the model and read like a log.
    const firstParagraph = output.trim().split(/\n\s*\n/)[0] ?? '';
    return compactClosing(firstParagraph, 'Step completed and handed off.', 280);
  }
  if (!policy?.toolNames.includes(toolName)) return null;
  if (policy.onlyWhenArgEquals) {
    const actual = args[policy.onlyWhenArgEquals.arg];
    if (
      typeof actual !== 'string' ||
      normalizePath(actual) !== normalizePath(policy.onlyWhenArgEquals.value)
    ) {
      return null;
    }
  }
  const closingArg = policy.closingArgByTool?.[toolName] ?? policy.closingArg;
  const fromArg =
    closingArg && typeof args[closingArg] === 'string' ? (args[closingArg] as string) : '';
  return compactClosing(fromArg, policy.fallbackText.trim(), policy.maxClosingChars ?? 180);
}

/**
 * A step's `advanceWhen` is judged only when the turn ends, so a model that
 * never ends its turn never learns the deliverable is done. Wild-caught on
 * qwen3.8-flash-next (spreadsheet-model 1.0.4, step `build`, advanceWhen
 * `index.html` + `html-complete`): `validate index.html` passed early, then
 * the developer kept polishing in one turn for 12-20 minutes — test files it
 * could not run, `replace_in_file`, greps — and never called
 * `write_task_note` or `advance_task_step` (2/2 runs). Only the
 * 96-iteration cap would have ended it, while every edit risked breaking a
 * passing file. Two footers per turn, then {@link DeliverableReadySteer}
 * closes the turn so the end-of-turn advance check takes over.
 */
export const DELIVERABLE_READY_FOOTER_LIMIT = 2;

/**
 * Tool-loop iterations a model may still run after its last footer before
 * the steer closes the turn. Enough to finish another named file, write the
 * note and advance; not enough for another polishing spree.
 */
export const DELIVERABLE_READY_GRACE_ITERATIONS = 4;

const DELIVERABLE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'insert_at_marker',
]);

function workspacePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^workspace\//, '')
    .replace(/^\/+/, '');
}

/**
 * Whether this call touched the workspace deliverable in a way that can mean
 * "done": a successful edit, or a `validate` of it that passed. A failed
 * validate is exactly when the model should keep working.
 */
export function deliverableTouch(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  deliverableFile: string,
): 'edit' | 'validate' | null {
  const target = workspacePath(deliverableFile);
  if (!target || typeof args.path !== 'string' || workspacePath(args.path) !== target) return null;
  const head = output.trimStart();
  const name = canonicalToolName(toolName);
  if (DELIVERABLE_EDIT_TOOLS.has(name)) {
    return head.startsWith('ERROR:') || head.startsWith('✗ ') ? null : 'edit';
  }
  if (name === 'validate' && args.where !== 'artifact') {
    return /— PASS\b/.test(head.split('\n', 1)[0] ?? '') ? 'validate' : null;
  }
  return null;
}

/**
 * The `[runtime]` line appended to a tool result once the workspace
 * deliverable meets its step's advance condition. Names a task tool only
 * when this turn wired it; with neither, the end-of-turn auto-advance is
 * the honest next step. "Finish any other file the procedure names" keeps
 * a multi-file build step (pwa-offline writes `sw.js` after `index.html`)
 * from reading this as permission to skip its remaining outputs.
 */
export function deliverableReadyFooter(input: {
  toolName: string;
  args: Record<string, unknown>;
  output: string;
  deliverableFile: string;
  ready: boolean;
  liveToolNames: ReadonlySet<string>;
  firedCount: number;
}): string | null {
  if (!input.ready || input.firedCount >= DELIVERABLE_READY_FOOTER_LIMIT) return null;
  if (!deliverableTouch(input.toolName, input.args, input.output, input.deliverableFile)) {
    return null;
  }
  const note = input.liveToolNames.has('write_task_note');
  const advance = input.liveToolNames.has('advance_task_step');
  const next =
    note && advance
      ? 'then call `write_task_note` with the path and result, then `advance_task_step`.'
      : advance
        ? 'then call `advance_task_step`.'
        : note
          ? 'then call `write_task_note` with the path and result and end your turn; the runtime advances the step.'
          : 'then end your turn; the runtime advances the step.';
  return `[runtime] \`${input.deliverableFile}\` now meets this step's completion condition — stop polishing it. Finish any other file the procedure names, ${next}`;
}

/**
 * Per-send owner of the deliverable-ready footer and its backstop, shared by
 * every local tool loop. Readiness comes from the host
 * ({@link ActiveCraftbookStep.deliverableReady}), so mid-turn and
 * end-of-turn read the same file through the same check.
 */
export class DeliverableReadySteer {
  private fired = 0;
  private writtenThisTurn = false;
  private advanceAttempted = false;
  private limitReachedThisIteration = false;
  private iterationsSinceLimit: number | null = null;

  static forStep(step: ActiveCraftbookStep | undefined): DeliverableReadySteer | null {
    if (!step?.deliverableReady || !step.deliverableFile || step.deliverableIsArtifact) return null;
    return new DeliverableReadySteer(step.deliverableFile, step.deliverableReady);
  }

  constructor(
    readonly deliverableFile: string,
    private readonly ready: (ctx: { writtenThisTurn: boolean }) => Promise<boolean>,
  ) {}

  get firedCount(): number {
    return this.fired;
  }

  /** The footer this tool result earned, or null. Call once per executed tool call. */
  async footerFor(
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    liveToolNames: () => ReadonlySet<string>,
  ): Promise<string | null> {
    if (canonicalToolName(toolName) === 'advance_task_step') {
      // Accepted or rejected, the step gate owns what happens next.
      this.advanceAttempted = true;
      return null;
    }
    const touch = deliverableTouch(toolName, args, output, this.deliverableFile);
    if (touch === 'edit') this.writtenThisTurn = true;
    if (!touch || this.fired >= DELIVERABLE_READY_FOOTER_LIMIT) return null;
    if (!(await this.isReady())) return null;
    const footer = deliverableReadyFooter({
      toolName,
      args,
      output,
      deliverableFile: this.deliverableFile,
      ready: true,
      liveToolNames: liveToolNames(),
      firedCount: this.fired,
    });
    if (!footer) return null;
    this.fired += 1;
    if (this.fired >= DELIVERABLE_READY_FOOTER_LIMIT) {
      this.iterationsSinceLimit = 0;
      this.limitReachedThisIteration = true;
    }
    return footer;
  }

  /**
   * Call once at the end of each tool-executing iteration. Returns the
   * closing reply when the model has ignored both footers for
   * {@link DELIVERABLE_READY_GRACE_ITERATIONS} more iterations and the
   * deliverable is still ready; the provider then ends the turn through its
   * terminal-action path and ChatManager's end-of-turn advance (and the
   * step's completion gate) decide the step, exactly as if the model had
   * stopped on its own.
   */
  async backstopClosing(): Promise<string | null> {
    if (this.iterationsSinceLimit === null || this.advanceAttempted) return null;
    if (this.limitReachedThisIteration) {
      this.limitReachedThisIteration = false;
      return null;
    }
    this.iterationsSinceLimit += 1;
    if (this.iterationsSinceLimit < DELIVERABLE_READY_GRACE_ITERATIONS) return null;
    // A file the model broke after the footers must not be handed off.
    if (!(await this.isReady())) return null;
    return `Finished \`${this.deliverableFile}\`; handing it to the step's completion check.`;
  }

  private async isReady(): Promise<boolean> {
    try {
      return await this.ready({ writtenThisTurn: this.writtenThisTurn });
    } catch {
      return false;
    }
  }
}
