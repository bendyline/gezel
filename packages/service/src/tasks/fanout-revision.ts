/**
 * A gate that loops a spawn host back into its fanout step after the crew
 * has finished.
 *
 * The fanout step used to be idempotent per TASK: any existing child skipped
 * the spawn, so the step stamped its manifest and advanced on the spot. A
 * reviewer's `onReject` into it was therefore a no-op — wild-caught on
 * invoice-run (qwen3.8-27b, 2026-10-01): evaluate rejected, "Gate looped …
 * back to Draft the invoices", draft completed in the same millisecond, and
 * collect re-ran over untouched invoices that could not address the verdict.
 *
 * Idempotency is now per ACTIVATION. A fresh activation whose earlier crew
 * has all settled, reached through a gate whose `onReject` names the fanout
 * step, runs a revision pass: the same spawn template over the current items,
 * each child carrying the review's findings in its notes. An earlier crew
 * still drafting is left alone — the post-fanout barrier waits for it — and a
 * re-activation from anywhere else (a user, a model route) keeps the old
 * advance-through behavior.
 *
 * Bounded by the gate's own `maxAttempts`: re-entering the gated step keeps
 * its attempt count when its rejections route into a fanout
 * ({@link carryFanoutLoopGateAttempts}), so the third failed review of an
 * invoice-run pauses the task on `evaluate` — where Try again resets the
 * budget — instead of buying another crew every pass.
 */
import {
  type Task,
  type TaskCraftbookStep,
  normalizeStepGate,
  taskEffectiveStatus,
} from '@bendyline/gezel';

/** Longest excerpt of the review's findings copied into each child's notes. */
const FINDINGS_EXCERPT_CHARS = 3_000;

export type FanoutActivation =
  | { kind: 'first' }
  | { kind: 'revise'; gatedStep: TaskCraftbookStep; pass: number }
  /** Already fanned out for this activation, crew still out, or not a gate loop. */
  | { kind: 'skip' };

/** The children spawned under the fanout step's current activation. */
export function currentRoundChildren(children: Task[], step: TaskCraftbookStep): Task[] {
  const activation = step.lastActivatedAt;
  return activation ? children.filter((child) => child.createdAt >= activation) : children;
}

/** The step whose gate rejection looped the host back into `fanoutStepId` since `since`. */
function loopingGateStep(
  task: Task,
  fanoutStepId: string,
  since: string,
): TaskCraftbookStep | undefined {
  let found: TaskCraftbookStep | undefined;
  for (const step of task.craftbook.steps) {
    const reject = step.lastGateReject;
    if (!step.gate || !reject || step.completedAt || reject.at < since) continue;
    if (normalizeStepGate(step.gate).onReject !== fanoutStepId) continue;
    if (!found || reject.at > found.lastGateReject!.at) found = step;
  }
  return found;
}

export function classifyFanoutActivation(
  task: Task,
  step: TaskCraftbookStep,
  children: Task[],
): FanoutActivation {
  if (children.length === 0) return { kind: 'first' };
  // A legacy step without an activation stamp cannot tell its rounds apart.
  if (!step.lastActivatedAt) return { kind: 'skip' };
  if (currentRoundChildren(children, step).length > 0) return { kind: 'skip' };
  const settled = (child: Task) => {
    const status = taskEffectiveStatus(child);
    return status === 'complete' || status === 'canceled';
  };
  if (!children.every(settled)) return { kind: 'skip' };
  const lastSpawn = children.reduce(
    (latest, child) => (child.createdAt > latest ? child.createdAt : latest),
    '',
  );
  const gatedStep = loopingGateStep(task, step.id, lastSpawn);
  if (!gatedStep) return { kind: 'skip' };
  return { kind: 'revise', gatedStep, pass: (gatedStep.gateAttempts ?? 1) + 1 };
}

/**
 * The note every revision child reads before it starts: which review sent
 * the work back and what it found. The findings are the gated step's own
 * deliverable (invoice-run's verdict.md), inlined because the children's
 * kit usually has no artifacts reader. The gate's message is deliberately
 * left out — it is written to the reviewer ("Add that content") and a child
 * that obeyed it would write into the reviewer's file.
 */
export function buildRevisionNote(opts: {
  fanoutStep: Pick<TaskCraftbookStep, 'name'>;
  gatedStep: TaskCraftbookStep;
  pass: number;
  findings: string | null;
}): string {
  const { fanoutStep, gatedStep, pass } = opts;
  const failed = gatedStep.gateAttemptHistory?.at(-1)?.failedChecks ?? [];
  const findings = opts.findings?.trim();
  const lines = [
    `# Revision pass ${pass} — the review sent this work back`,
    '',
    `"${gatedStep.name}" did not pass the run, so the task looped back to "${fanoutStep.name}" and every item is being done again. The previous pass's result for this item is still in place.`,
    '',
  ];
  if (failed.length > 0) lines.push(`Checks that failed: ${failed.join('; ')}.`, '');
  if (findings) {
    const excerpt =
      findings.length > FINDINGS_EXCERPT_CHARS
        ? `${findings.slice(0, FINDINGS_EXCERPT_CHARS)}\n… (truncated)`
        : findings;
    const file = gatedStep.advanceWhen?.file;
    lines.push(
      `## What the review found${file ? ` (${file})` : ''}`,
      '',
      '~~~',
      excerpt,
      '~~~',
      '',
    );
  }
  lines.push(
    'Fix whatever the review says about this item, keep everything your step asks for, and write the result again. If the review names nothing about this item, check your result against your step and finish.',
  );
  return lines.join('\n');
}

/**
 * Keep the gate's attempt count when the task re-enters a gated step whose
 * rejections route into a fanout step of this spawn host. An ordinary
 * upstream loop earns a clean budget (the rework there is the gezel's own),
 * but each fanout pass buys a whole crew, and without the carry the
 * evaluate → draft → collect → evaluate loop never reaches `maxAttempts`.
 * Only `gateAttempts` carries: the new pass's deliverable is judged afresh.
 */
export function carryFanoutLoopGateAttempts(
  task: Pick<Task, 'spawnsCraftbook' | 'craftbook'>,
  before: TaskCraftbookStep[],
  after: TaskCraftbookStep[],
  stepId: string,
): TaskCraftbookStep[] {
  const prior = before.find((step) => step.id === stepId);
  if (!prior?.gate || !prior.gateAttempts || prior.completedAt) return after;
  if (!task.spawnsCraftbook || !task.craftbook.spawn) return after;
  const onReject = normalizeStepGate(prior.gate).onReject;
  if (!before.some((step) => step.id === onReject && step.spawnFanout)) return after;
  return after.map((step) =>
    step.id === stepId ? { ...step, gateAttempts: prior.gateAttempts } : step,
  );
}
