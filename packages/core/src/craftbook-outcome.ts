/**
 * Shaping a task's book for its strategy around the book's contract.
 *
 * The contract (goal, deliverables, quality bar) is the same bar under every
 * strategy, so the comparison measures the strategy and not the gates:
 *
 *  - `outcome` folds the recipe into one terminal step whose only gate is the
 *    contract ({@link renderCraftbookAsOutcome}).
 *  - `stepwise` and `generalist` keep the recipe and add the contract to the
 *    terminal step's completion gate, looping back to the step that produces
 *    the deliverable when it fails ({@link withTerminalContractGate}).
 *
 * Contract checks read evidence across the whole task (`window: 'task'`):
 * what an earlier step, an earlier attempt or a teammate read still counts.
 */
import { checkedFiles } from './craftbook-contract-lint.js';
import {
  type CraftbookContract,
  contractGateChecks,
  deliverableRole,
} from './schemas/craftbook-contract.js';
import {
  GATE_DEFAULT_MAX_ATTEMPTS,
  type GateCheck,
  type StepGate,
  normalizeStepGate,
} from './schemas/gate.js';
import type { TaskCraftbook, TaskCraftbookStep } from './schemas/task.js';
import { isOwnerStep } from './task-execution.js';
import type { TaskStrategyOptions } from './task-strategy.js';

/** Id of the one step an outcome render produces. */
export const OUTCOME_STEP_ID = 'outcome';

/** The contract's gate checks, reading evidence task-wide unless a check says otherwise. */
export function contractChecksForTask(contract: CraftbookContract): GateCheck[] {
  return contractGateChecks(contract).map((check) =>
    (check.kind === 'researchEvidence' || check.kind === 'commandEvidence') && !check.window
      ? { ...check, window: 'task' as const }
      : check,
  );
}

/**
 * Why a book cannot be folded into one outcome step, or null when it can.
 * A step the person does themselves, a conditional step, script routing, an
 * activation gate and a script that runs between steps all depend on the
 * recipe's order, which an outcome render gives up. The entry step's
 * `onEnter` is kept: it runs before any work, which is where it ran before.
 */
export function outcomeRenderGap(
  craftbook: Pick<TaskCraftbook, 'steps' | 'entryStepId' | 'contract'>,
  spawnsCraftbook?: Pick<TaskCraftbook, 'steps'>,
): string | null {
  if (!craftbook.contract)
    return 'the book has no contract, so it states no outcome to hold the work to';
  if (contractGateChecks(craftbook.contract).length === 0) {
    return 'the book’s contract has no checked criteria, so nothing would gate the outcome';
  }
  const steps: Array<{ step: TaskCraftbookStep; entry: boolean }> = [
    ...craftbook.steps.map((step) => ({ step, entry: step.id === craftbook.entryStepId })),
    ...(spawnsCraftbook?.steps ?? []).map((step) => ({ step, entry: false })),
  ];
  for (const { step, entry } of steps) {
    if (isOwnerStep(step)) return `step "${step.id}" is done by the person`;
    if (step.runWhen) return `step "${step.id}" runs only under a condition`;
    if (step.branches?.length) return `step "${step.id}" routes on a script result`;
    if (step.gate && normalizeStepGate(step.gate).at === 'activation') {
      return `step "${step.id}" has an activation gate`;
    }
    if (!entry && step.onEnter) return `step "${step.id}" runs a script when it starts`;
    if (step.onExit) return `step "${step.id}" runs a script when it ends`;
  }
  return null;
}

export type OutcomeRenderResult =
  | { ok: true; craftbook: TaskCraftbook }
  | { ok: false; reason: string };

/**
 * Fold a task's book into one terminal step held to the book's contract.
 * The recipe's prompts become an advisory approach (or are left out with
 * `procedure: 'none'`), a fanout is done inline, and the original steps are
 * kept in `sourceSteps` so the tools they name stay callable. Never falls
 * back: a caller that asked for outcome on a book that cannot be rendered
 * gets the reason.
 */
export function renderCraftbookAsOutcome(
  craftbook: TaskCraftbook,
  opts: {
    spawnsCraftbook?: TaskCraftbook | undefined;
    options?: TaskStrategyOptions | undefined;
    now: string;
  },
): OutcomeRenderResult {
  const gap = outcomeRenderGap(craftbook, opts.spawnsCraftbook);
  if (gap) return { ok: false, reason: gap };
  const contract = craftbook.contract!;
  const entry = craftbook.steps.find((step) => step.id === craftbook.entryStepId);
  const primary = contract.deliverables.find((d) => deliverableRole(d) === 'primary');
  const producer = primary
    ? craftbook.steps[producerIndex(craftbook.steps, primary.path, primary.artifact === true)]
    : undefined;
  // Finishing rides on the primary deliverable, as it did for the step that
  // wrote it: a small model that does the work rarely calls the advance tool.
  const producerAdvance =
    producer?.advanceWhen &&
    primary &&
    normalizePath(producer.advanceWhen.file) === normalizePath(primary.path) &&
    (producer.advanceWhen.artifact === true) === (primary.artifact === true)
      ? (({ goto: _goto, ...rest }) => rest)(producer.advanceWhen)
      : undefined;
  const authoring =
    producer?.authoring ?? craftbook.steps.find((step) => step.authoring)?.authoring;
  // The same number of tries at the contract a stepwise run gets on its
  // terminal step: there, the plateau pause ends the loop on the fourth
  // identical rejection however many loop-backs reset the attempt count.
  const gate: StepGate = {
    at: 'completion',
    checks: contractChecksForTask(contract),
    maxAttempts: GATE_DEFAULT_MAX_ATTEMPTS,
  };
  const step: TaskCraftbookStep = {
    id: OUTCOME_STEP_ID,
    name: 'Deliver the outcome',
    description: contract.goal,
    prompt: renderOutcomeStepPrompt(craftbook, opts.spawnsCraftbook, opts.options ?? {}),
    ...(entry?.suggestedRole ? { suggestedRole: entry.suggestedRole } : {}),
    ...(entry?.assignee ? { assignee: entry.assignee } : {}),
    ...(entry?.suggestedGezelId ? { suggestedGezelId: entry.suggestedGezelId } : {}),
    ...(entry?.retrieval ? { retrieval: entry.retrieval } : {}),
    ...(entry?.consumes ? { consumes: entry.consumes } : {}),
    ...(entry?.onEnter ? { onEnter: entry.onEnter } : {}),
    ...(authoring ? { authoring } : {}),
    ...(producerAdvance ? { advanceWhen: producerAdvance } : {}),
    gate,
    terminal: true,
    createdAt: opts.now,
  };
  const spawnSteps = (opts.spawnsCraftbook?.steps ?? []).map((s) => ({ ...s, id: `each-${s.id}` }));
  const { spawn: _spawn, ...rest } = craftbook;
  return {
    ok: true,
    craftbook: {
      ...rest,
      steps: [step],
      entryStepId: OUTCOME_STEP_ID,
      renderedAs: 'outcome',
      sourceSteps: [...craftbook.steps, ...spawnSteps],
      updatedAt: opts.now,
    },
  };
}

function renderOutcomeStepPrompt(
  craftbook: TaskCraftbook,
  spawnsCraftbook: TaskCraftbook | undefined,
  options: TaskStrategyOptions,
): string {
  const parts = [
    'Deliver the outcome the **Task contract** describes. You own all of it, in this one conversation, and you choose how to get there: work directly toward deliverables that meet the bar.',
  ];
  if (options.subagents !== false) {
    parts.push(
      'When teammate tools (`consult_<role>`) are among your tools, you may hand a self-contained piece of the work to a teammate: say exactly which files to read and which to write. They work in this project and answer within your turn. You stay responsible for the deliverables, so check what they wrote.',
    );
  }
  parts.push(
    'When every deliverable is in place, call advance_task_step once. The runtime checks the contract and names anything unmet; fix exactly that and call it again.',
  );
  if (options.procedure === 'none') return parts.join('\n\n');
  const recipe: string[] = [
    '#### Recommended approach (advisory)',
    'The recipe this outcome usually follows. Use what helps; reorder, merge or skip parts when you can reach the outcome more directly. Files it writes along the way are optional unless the contract lists them. Where it says to advance a step, move on to the next part; advance the task only once, at the end.',
  ];
  craftbook.steps.forEach((step, i) => {
    recipe.push(
      `##### ${i + 1}. ${step.name}\n\n${(step.prompt ?? step.description ?? '').trim()}`,
    );
    if (step.spawnFanout && craftbook.spawn && spawnsCraftbook) {
      const items = craftbook.spawn.itemsPath
        ? `the \`${craftbook.spawn.itemsPath}\` array in \`${craftbook.spawn.overFile}\``
        : `\`${craftbook.spawn.overFile}\``;
      const drawer = craftbook.spawn.overArtifact ? ' (artifacts drawer)' : '';
      const each = spawnsCraftbook.steps
        .map((child) => `- **${child.name}**: ${(child.prompt ?? child.description ?? '').trim()}`)
        .join('\n');
      recipe.push(
        `##### For each item in ${items}${drawer}\n\nThe recipe gives every item to its own worker here. Handle the items yourself (or hand them to teammates). Placeholders like \`{{name}}\` stand for the item's fields.\n\n${each}`,
      );
    }
  });
  return [...parts, recipe.join('\n\n')].join('\n\n');
}

/**
 * Index of the step that writes `path`: the last one that auto-advances on
 * it, gates on it, or names it in its procedure. -1 when none does.
 */
function producerIndex(steps: TaskCraftbookStep[], path: string, artifact: boolean): number {
  const target = normalizePath(path);
  const names = (file: string | undefined) => file !== undefined && normalizePath(file) === target;
  const score = (step: TaskCraftbookStep): number => {
    if (
      step.advanceWhen &&
      names(step.advanceWhen.file) &&
      (step.advanceWhen.artifact === true) === artifact
    ) {
      return 3;
    }
    const checks = step.gate ? normalizeStepGate(step.gate).checks : [];
    if (checks.some((check) => checkedFiles(check).some(names))) return 2;
    if ((step.prompt ?? '').includes(path)) return 1;
    return 0;
  };
  let best = -1;
  let bestScore = 0;
  steps.forEach((step, i) => {
    const s = score(step);
    if (s > 0 && s >= bestScore) {
      best = i;
      bestScore = s;
    }
  });
  return best;
}

/**
 * Add the book's contract to its terminal step's completion gate, so a
 * stepwise or generalist run is held to the bar an outcome run is. A failed
 * contract loops back to the step that writes the primary deliverable.
 * Only the terminal steps a successful run reaches are gated; escalation
 * exits, steps the person does themselves, and steps gated at activation are
 * left alone. No contract, or no checked criteria: unchanged.
 */
export function withTerminalContractGate(craftbook: TaskCraftbook): TaskCraftbook {
  if (!craftbook.contract || craftbook.renderedAs === 'outcome') return craftbook;
  const checks = contractChecksForTask(craftbook.contract);
  if (checks.length === 0) return craftbook;
  const terminalIds = new Set(finishingSteps(craftbook.steps).map((step) => step.id));
  const primary = craftbook.contract.deliverables.find((d) => deliverableRole(d) === 'primary');
  const producerAt = primary
    ? producerIndex(craftbook.steps, primary.path, primary.artifact === true)
    : -1;
  const producer = producerAt >= 0 ? craftbook.steps[producerAt] : undefined;
  let changed = false;
  const steps = craftbook.steps.map((step) => {
    if (!terminalIds.has(step.id) || isOwnerStep(step)) return step;
    if (!step.gate) {
      changed = true;
      const loopBack = producer && producer.id !== step.id ? { onReject: producer.id } : {};
      return { ...step, gate: { at: 'completion' as const, checks, ...loopBack } };
    }
    const gate = normalizeStepGate(step.gate);
    if (gate.at !== 'completion' || gate.legacy) return step;
    const present = new Set(gate.checks.map((check) => JSON.stringify(check)));
    const added = checks.filter((check) => !present.has(JSON.stringify(check)));
    if (added.length === 0) return step;
    changed = true;
    return { ...step, gate: { ...(step.gate as StepGate), checks: [...gate.checks, ...added] } };
  });
  return changed ? { ...craftbook, steps } : craftbook;
}

/**
 * The terminal steps a run reaches when it succeeds: those some step routes to
 * by default (`next`, an auto-advance `goto`, a gate's `onApprove`, or array
 * order). An escalation exit such as `needs-user` is reached only by an
 * explicit jump; gating it would turn "stop and ask" into a pause for help.
 */
function finishingSteps(steps: readonly TaskCraftbookStep[]): TaskCraftbookStep[] {
  const terminals = steps.filter((step) => step.terminal);
  if (terminals.length === 0) return steps.slice(-1);
  const defaultTargets = new Set<string>();
  steps.forEach((step, i) => {
    if (step.terminal) return;
    if (step.next) defaultTargets.add(step.next);
    else if (!step.branches?.length && steps[i + 1]) defaultTargets.add(steps[i + 1]!.id);
    if (step.advanceWhen?.goto) defaultTargets.add(step.advanceWhen.goto);
    const approve = step.gate ? normalizeStepGate(step.gate).onApprove : undefined;
    if (approve) defaultTargets.add(approve);
  });
  const reached = terminals.filter((step) => defaultTargets.has(step.id));
  return reached.length > 0 ? reached : terminals;
}

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, '').toLowerCase();
}
