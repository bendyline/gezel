/**
 * Handoffs a stepwise step needs but its craftbook did not declare.
 *
 * A stepwise step runs in a fresh session that knows only what its prompt
 * tells it to open, so a file an earlier step wrote but this step does not
 * `consume` does not exist for it. Across the pinned gilde catalog, 160 of
 * 296 books have a later different-role step whose procedure names an
 * upstream file it does not consume, and 181 of 208 books whose first step
 * writes a scope or plan file never consume it again (2026-10-06 review).
 * Generalist mode hides the gap because one owner remembers; that, more than
 * the mode, is why it led the paired runs. These helpers close the gap in
 * the runtime for every book at once instead of waiting on 160 content edits.
 */
import { stepDeliverableTarget } from '../deliverable.js';
import type { Task, TaskCraftbookStep } from '../schemas/task.js';

export interface InferredStepInput {
  file: string;
  artifact: boolean;
  /** Name of the earlier step that produced it. */
  producedBy: string;
}

export interface StepProduct {
  stepName: string;
  file: string;
  artifact: boolean;
}

const MAX_INFERRED_INPUTS = 4;
const MAX_EARLIER_PRODUCTS = 8;

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/** True when `text` names `token` as a whole path token, not inside a longer name. */
function namesToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\w./-])${escaped}(?![\\w-])`).test(text);
}

/** True when `text` names `path` in full, or names its file-like basename. */
function mentionsFile(text: string, path: string): boolean {
  if (namesToken(text, path)) return true;
  const base = basename(path);
  if (base === path || !/\.[A-Za-z0-9]{1,8}$/.test(base) || base.length < 5) return false;
  return namesToken(text, base);
}

/** Files the finished steps before `active` produced, in step order. */
export function earlierStepProducts(
  steps: readonly TaskCraftbookStep[],
  active: TaskCraftbookStep,
): StepProduct[] {
  const own = stepDeliverableTarget(active)?.path;
  const seen = new Set<string>();
  const out: StepProduct[] = [];
  for (const step of steps) {
    if (step.id === active.id || !step.completedAt) continue;
    const target = stepDeliverableTarget(step);
    if (!target || target.path === own || seen.has(target.path)) continue;
    seen.add(target.path);
    out.push({ stepName: step.name, file: target.path, artifact: target.artifact });
    if (out.length === MAX_EARLIER_PRODUCTS) break;
  }
  return out;
}

/**
 * Earlier steps' files that `active`'s procedure names but does not consume.
 * Rendered as required inputs beside the declared ones.
 */
export function inferredStepInputs(
  steps: readonly TaskCraftbookStep[],
  active: TaskCraftbookStep,
): InferredStepInput[] {
  const procedure = `${active.prompt ?? ''}\n${active.description ?? ''}`;
  if (!procedure.trim()) return [];
  const declared = new Set((active.consumes ?? []).map((input) => input.file.trim()));
  const declaredBases = new Set([...declared].map(basename));
  const out: InferredStepInput[] = [];
  for (const product of earlierStepProducts(steps, active)) {
    if (declared.has(product.file) || declaredBases.has(basename(product.file))) continue;
    if (!mentionsFile(procedure, product.file)) continue;
    out.push({ file: product.file, artifact: product.artifact, producedBy: product.stepName });
    if (out.length === MAX_INFERRED_INPUTS) break;
  }
  return out;
}

/**
 * `step` with its inferred inputs appended to `consumes`, for the parts of
 * the runtime that act on declared inputs (the reader that survives tool
 * clamps, the read-before-write anchor). Generalist tasks are returned as is.
 */
export function withInferredConsumes<T extends TaskCraftbookStep>(
  task: {
    executionMode?: Task['executionMode'];
    craftbook: { steps: readonly TaskCraftbookStep[] };
  },
  step: T,
): T {
  if (task.executionMode === 'generalist') return step;
  const inferred = inferredStepInputs(task.craftbook.steps, step);
  if (inferred.length === 0) return step;
  return {
    ...step,
    consumes: [
      ...(step.consumes ?? []),
      ...inferred.map((input) => ({
        file: input.file,
        ...(input.artifact ? { artifact: true } : {}),
      })),
    ],
  };
}
