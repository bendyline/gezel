import type { CraftbookStep } from '@bendyline/gezel';
import { normalizeScriptRefs, normalizeStepGate } from '@bendyline/gezel';

/**
 * A craftbook step is a "gate" — a phase the model must hold at until its
 * exit criteria are met, rather than advance past on its first attempt —
 * when ANY of:
 *
 *   (a) it loops back: an outgoing edge (`next` or any `branches[].goto`)
 *       targets itself or an earlier step in the recipe. This is the
 *       build-loop `evaluate → build` / reviewer-loop `revise → critique`
 *       shape — the step exists precisely to be re-entered until good.
 *   (b) it carries `onExit` script(s): advancement is conditioned on
 *       the last script's output (the `ship` craftbook's `run-tests` shape).
 *   (c) it carries a COMPLETION gate: `advance_task_step` is rejected by
 *       the runtime until the gate's checks/scripts approve the work.
 *
 * The system-prompt builder uses this to decide whether to inject the
 * phase-gate anchor ("do not advance past an unmet gate — loop back and
 * fix the gap"), which is the keystone fix for small models "losing the
 * plot" and declaring victory early on multi-phase work.
 *
 * Pure and cheap (linear in step count) so it can be recomputed wherever
 * step context is assembled. Forward-only books (investigate, office-hours)
 * return false for every step — they get no gate anchor, by design.
 */
export function isGatedStep(
  step: Pick<CraftbookStep, 'id' | 'next' | 'branches' | 'onExit' | 'gate'>,
  steps: ReadonlyArray<Pick<CraftbookStep, 'id'>>,
): boolean {
  if (normalizeScriptRefs(step.onExit).length > 0) return true;
  if (step.gate && normalizeStepGate(step.gate).at === 'completion') return true;
  const idx = steps.findIndex((s) => s.id === step.id);
  if (idx < 0) return false;
  const targets = [...(step.next ? [step.next] : []), ...(step.branches?.map((b) => b.goto) ?? [])];
  return targets.some((target) => {
    const ti = steps.findIndex((s) => s.id === target);
    // A self-edge (ti === idx) or backward edge (ti < idx) is a loop.
    return ti >= 0 && ti <= idx;
  });
}
