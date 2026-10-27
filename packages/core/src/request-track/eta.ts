import type { CraftbookStepStage } from '../schemas/craftbook.js';
import type { Task, TaskCraftbookStep } from '../schemas/task.js';
import { awakeMsBetween } from '../tasks/work-time.js';
import { type EtaEngine, STAGE_DURATION_SEEDS, STEP_DURATION_SEEDS } from './duration-seeds.js';
import { craftbookStepStages } from './stage.js';

/** What this install's finished work says about how long things take. */
export interface DurationEstimates {
  /** Whole-run medians keyed by the book's catalog id (the New Task dialog's estimate). */
  books: Record<string, number>;
  /** Step medians keyed `<engine|any>|<bookId>:<stepId>`. */
  steps: ReadonlyMap<string, number>;
  /** Stage medians keyed `<engine|any>|<stage>`. */
  stages: ReadonlyMap<string, number>;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

function medians(samples: Map<string, number[]>): Map<string, number> {
  return new Map([...samples].map(([key, values]) => [key, median(values)]));
}

function push(samples: Map<string, number[]>, key: string, value: number): void {
  const values = samples.get(key) ?? [];
  values.push(value);
  samples.set(key, values);
}

function bookIdOf(task: Pick<Task, 'sourceCraftbookIds'>): string | undefined {
  return task.sourceCraftbookIds?.find((source) => source.role === 'main')?.catalogId;
}

/**
 * Overnight waits, recurring hosts and fanout children are different jobs,
 * not samples of an immediate launch. A run from before work time was kept
 * has only wall-clock times, which count its pauses and the days the laptop
 * was closed (a 41-minute deck read as 84 hours), so it is no sample either.
 */
function isImmediateRun(task: Task): boolean {
  return (
    task.workMs !== undefined &&
    task.status === 'complete' &&
    !task.nightShift &&
    !task.cron &&
    !task.spawnsCraftbook &&
    !task.parentTaskRef
  );
}

/**
 * Medians of this install's work time on finished runs: per book, per step
 * and per stage, each also split by where the run went (`engineOf`) when
 * known. Work time assumes the computer stays on (see `accrueTaskWork`); a
 * step counts its final pass.
 */
export function stepDurationEstimates(
  tasks: readonly Task[],
  opts: { engineOf?: (task: Task) => EtaEngine | undefined } = {},
): DurationEstimates {
  const books = new Map<string, number[]>();
  const steps = new Map<string, number[]>();
  const stages = new Map<string, number[]>();
  for (const task of tasks) {
    if (!isImmediateRun(task)) continue;
    const bookId = bookIdOf(task);
    const run = task.workMs ?? 0;
    const finished = task.craftbook.steps.some((step) => step.completedAt);
    if (bookId && finished && run > 0) push(books, bookId, run);

    const ran = opts.engineOf?.(task);
    const engines = ran ? ['any', ran] : ['any'];
    const stageOf = craftbookStepStages(task.craftbook.steps);
    for (const step of task.craftbook.steps) {
      const took = step.workMs ?? 0;
      if (!step.completedAt || took <= 0) continue;
      const stage = stageOf.get(step.id) ?? 'make';
      for (const engine of engines) {
        if (bookId) push(steps, `${engine}|${bookId}:${step.id}`, took);
        push(stages, `${engine}|${stage}`, took);
      }
    }
  }
  return {
    books: Object.fromEntries(medians(books)),
    steps: medians(steps),
    stages: medians(stages),
  };
}

function stepEstimate(
  bookId: string | undefined,
  step: TaskCraftbookStep,
  stage: CraftbookStepStage,
  estimates: DurationEstimates,
  engine: EtaEngine | undefined,
): number {
  const lookups = (map: ReadonlyMap<string, number>, key: string) =>
    (engine ? map.get(`${engine}|${key}`) : undefined) ?? map.get(`any|${key}`);
  const shipped = engine ?? 'device';
  return (
    (bookId ? lookups(estimates.steps, `${bookId}:${step.id}`) : undefined) ??
    (bookId ? STEP_DURATION_SEEDS[`${bookId}:${step.id}`]?.[shipped] : undefined) ??
    lookups(estimates.stages, stage) ??
    STAGE_DURATION_SEEDS[shipped][stage]
  );
}

/** The steps still ahead on the book's main path, the active one first. */
function pathFrom(steps: readonly TaskCraftbookStep[], activeId: string): TaskCraftbookStep[] {
  const out: TaskCraftbookStep[] = [];
  const seen = new Set<string>();
  let index = steps.findIndex((step) => step.id === activeId);
  while (index >= 0 && index < steps.length && !seen.has(steps[index]!.id)) {
    const step = steps[index]!;
    seen.add(step.id);
    out.push(step);
    if (step.terminal) break;
    index = step.next ? steps.findIndex((s) => s.id === step.next) : index + 1;
  }
  return out;
}

export interface RemainingEstimate {
  remainingMs: number;
  /** No run of this book has finished on this install, so the time is a guess. */
  firstTime: boolean;
  /** The step under way has run well past what it usually takes. */
  overdue: boolean;
}

/** An overdue step has run past both half again its estimate and three more minutes. */
const OVERDUE_FACTOR = 1.5;
const OVERDUE_MARGIN_MS = 3 * 60_000;

/**
 * How long the rest of `task` should take: what is left of the step under
 * way, plus every step after it on the book's main path. Each step's figure
 * is this install's own median for that step, else the book's shipped seed,
 * else this install's median for the stage, else the stage's shipped seed.
 */
export function estimateRemaining(
  task: Pick<
    Task,
    | 'craftbook'
    | 'activeStepId'
    | 'sourceCraftbookIds'
    | 'createdAt'
    | 'status'
    | 'workMs'
    | 'workedThrough'
  >,
  estimates: DurationEstimates,
  opts: { now: number; engine?: EtaEngine },
): RemainingEstimate | null {
  if (!task.activeStepId) return null;
  const bookId = bookIdOf(task);
  const stageOf = craftbookStepStages(task.craftbook.steps);
  const path = pathFrom(task.craftbook.steps, task.activeStepId);
  const active = path[0];
  if (!active) return null;
  const figure = (step: TaskCraftbookStep) =>
    stepEstimate(bookId, step, stageOf.get(step.id) ?? 'make', estimates, opts.engine);
  const activeFigure = figure(active);
  // Measured like the medians, so a nap does not read as a step running late.
  const startedAt = Date.parse(active.lastActivatedAt ?? task.createdAt);
  const elapsed =
    task.workMs !== undefined
      ? (active.workMs ?? 0) +
        (task.status === 'active'
          ? awakeMsBetween(Date.parse(task.workedThrough ?? ''), opts.now)
          : 0)
      : Number.isFinite(startedAt)
        ? Math.max(0, opts.now - startedAt)
        : 0;
  const rest = path.slice(1).reduce((sum, step) => sum + figure(step), 0);
  return {
    remainingMs: Math.max(0, activeFigure - elapsed) + rest,
    firstTime: !bookId || estimates.books[bookId] === undefined,
    overdue: elapsed > Math.max(activeFigure * OVERDUE_FACTOR, activeFigure + OVERDUE_MARGIN_MS),
  };
}

/** A duration as a person says it: "a minute", "40 minutes", "2 hours". */
export function spanWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return minutes === 1 ? 'a minute' : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'an hour' : `${hours} hours`;
}

/** The tracker's estimate line: "About 4 minutes left", or why it cannot say. */
export function remainingText(estimate: RemainingEstimate): string {
  if (estimate.overdue) return 'Taking longer than usual';
  const span = spanWords(estimate.remainingMs);
  return estimate.firstTime ? `First time here: about ${span}` : `About ${span} left`;
}
