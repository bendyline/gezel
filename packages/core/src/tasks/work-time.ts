import type { Task, TaskCraftbookStep } from '../schemas/task.js';
import { suspensionsSince } from '../suspend-clock.js';

/** Before this, the computer may have been off: that time is nobody's work. */
const processStartedAt = Date.now();

/**
 * Awake time between `from` and `now` that this process saw: nothing before
 * it started and nothing while the host slept. Undercounts a stretch an
 * earlier process ran, never counts a week the laptop sat closed.
 */
export function awakeMsBetween(from: number, now: number = Date.now()): number {
  const start = Math.max(from, processStartedAt);
  if (!(now > start)) return 0;
  let slept = 0;
  for (const s of suspensionsSince(start)) slept += Math.min(s.suspendedMs, s.at - start);
  return Math.max(0, now - start - slept);
}

function withoutWork(step: TaskCraftbookStep): TaskCraftbookStep {
  const { workMs: _workMs, ...rest } = step;
  void _workMs;
  return rest;
}

/**
 * The record about to be written, with its work time brought up to date from
 * the record on disk (never the caller's copy, which may be stale). The time
 * since the last write counts only when the task was active then, and goes to
 * the step that was active. Tasks from before work time was kept stay without
 * it, since their earlier pauses and downtime are unknowable.
 */
export function accrueTaskWork(
  current: Task | null | undefined,
  next: Task,
  opts: { now?: number; awake?: (from: number, now: number) => number } = {},
): Task {
  const now = opts.now ?? Date.now();
  const workedThrough = new Date(now).toISOString();
  if (!current) {
    return {
      ...next,
      workMs: 0,
      workedThrough,
      craftbook: { ...next.craftbook, steps: next.craftbook.steps.map(withoutWork) },
    };
  }
  if (current.workMs === undefined) return next;
  const from = Date.parse(current.workedThrough ?? '');
  const spent =
    current.status === 'active' && Number.isFinite(from)
      ? Math.round((opts.awake ?? awakeMsBetween)(from, now))
      : 0;
  const before = new Map(current.craftbook.steps.map((step) => [step.id, step]));
  const steps = next.craftbook.steps.map((step) => {
    const prior = before.get(step.id);
    // A re-activated step starts a fresh pass.
    if (!prior || prior.lastActivatedAt !== step.lastActivatedAt) return withoutWork(step);
    const workMs = (prior.workMs ?? 0) + (step.id === current.activeStepId ? spent : 0);
    return workMs > 0 ? { ...step, workMs } : withoutWork(step);
  });
  return {
    ...next,
    workMs: current.workMs + spent,
    workedThrough,
    craftbook: { ...next.craftbook, steps },
  };
}
