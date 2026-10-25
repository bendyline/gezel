/**
 * Task strategy — how much of a craftbook's recipe the runtime imposes on the
 * gezel doing the work.
 *
 *  - `stepwise`: a specialist per step, a fresh session per gezel change, a
 *    per-step tool kit, every step gate enforced.
 *  - `generalist`: one owner walks every step in one session with the union
 *    of the steps' tools; steps are still disclosed one at a time and every
 *    step gate still applies.
 *  - `outcome`: one owner, one step. The book's contract (goal, deliverables,
 *    quality bar) is the instruction and the only gate; the recipe is shown
 *    as advice the owner may follow, reorder or skip, and the owner may hand
 *    self-contained pieces to teammates.
 *
 * Outcome needs generalist's session semantics (one pinned owner, one
 * transcript, no per-step model routing), so it is generalist execution plus
 * an outcome render of the book (`TaskCraftbook.renderedAs`). That keeps
 * `Task.executionMode` two-valued for older readers and the eval harness.
 *
 * `auto` reproduces `generalistMode`'s task rule exactly and never picks
 * outcome: outcome is unmeasured, and `auto` follows evidence. See
 * docs/task-strategies.md.
 */
import {
  type GeneralistModeSetting,
  type TaskExecutionMode,
  resolveTaskExecutionMode,
} from './generalist-mode.js';

export const TASK_STRATEGIES = ['stepwise', 'generalist', 'outcome'] as const;
export type TaskStrategy = (typeof TASK_STRATEGIES)[number];
export type TaskStrategySetting = 'auto' | TaskStrategy;

/** Variants of the outcome strategy, used to separate its ingredients in evals. */
export interface TaskStrategyOptions {
  /** Show the recipe as advice (`advisory`, the default) or leave it out (`none`). */
  procedure?: 'advisory' | 'none';
  /** Let the owner hand self-contained pieces to teammates. Default true. */
  subagents?: boolean;
}

export function isTaskStrategy(value: unknown): value is TaskStrategy {
  return typeof value === 'string' && (TASK_STRATEGIES as readonly string[]).includes(value);
}

/** The session semantics a strategy runs under. */
export function executionModeForStrategy(strategy: TaskStrategy): TaskExecutionMode {
  return strategy === 'stepwise' ? 'stepwise' : 'generalist';
}

/**
 * Resolve the install's strategy. `taskStrategy` wins when it names one;
 * otherwise the task half of `generalistMode` decides, which under `auto`
 * is generalist for frontier providers and stepwise for everything else.
 */
export function resolveTaskStrategy(
  config: { taskStrategy?: TaskStrategySetting; generalistMode?: GeneralistModeSetting },
  providerName: string | undefined,
  tier?: string,
): TaskStrategy {
  if (config.taskStrategy && config.taskStrategy !== 'auto') return config.taskStrategy;
  return resolveTaskExecutionMode(config.generalistMode, providerName, tier);
}

/**
 * What a task asks for before the provider is known: the per-task strategy,
 * else the per-task execution mode, else `auto` (the install decides).
 */
export function requestedTaskStrategy(request: {
  strategy?: TaskStrategySetting;
  executionMode?: 'auto' | TaskExecutionMode;
}): TaskStrategySetting {
  if (request.strategy && request.strategy !== 'auto') return request.strategy;
  if (request.executionMode && request.executionMode !== 'auto') return request.executionMode;
  return 'auto';
}

/** A read-only description of what each strategy imposes, for docs, UI and evals. */
export interface TaskStrategyProfile {
  strategy: TaskStrategy;
  session: 'per-step' | 'single';
  tools: 'per-step' | 'union';
  roles: 'per-step' | 'owner';
  procedure: 'enforced' | 'advisory' | 'none';
  stepGates: boolean;
  subagents: boolean;
}

export function strategyProfile(
  strategy: TaskStrategy,
  options: TaskStrategyOptions = {},
): TaskStrategyProfile {
  if (strategy === 'stepwise') {
    return {
      strategy,
      session: 'per-step',
      tools: 'per-step',
      roles: 'per-step',
      procedure: 'enforced',
      stepGates: true,
      subagents: false,
    };
  }
  if (strategy === 'generalist') {
    return {
      strategy,
      session: 'single',
      tools: 'union',
      roles: 'owner',
      procedure: 'enforced',
      stepGates: true,
      subagents: false,
    };
  }
  return {
    strategy,
    session: 'single',
    tools: 'union',
    roles: 'owner',
    procedure: options.procedure ?? 'advisory',
    stepGates: false,
    subagents: options.subagents ?? true,
  };
}

/** True when the task was rendered for the outcome strategy. */
export function isOutcomeTask(task: {
  craftbook: { renderedAs?: 'outcome' | undefined };
}): boolean {
  return task.craftbook.renderedAs === 'outcome';
}

/**
 * The steps whose tools a task's sessions may use. An outcome task keeps
 * the recipe's steps for this, so a tool its procedure names (a converter,
 * a test runner) stays callable after the steps were folded into one.
 */
export function taskSurfaceSteps<S>(craftbook: { steps: S[]; sourceSteps?: S[] | undefined }): S[] {
  return craftbook.sourceSteps?.length ? craftbook.sourceSteps : craftbook.steps;
}

/** Whether an outcome task's owner may hand work to teammates. */
export function outcomeTaskHasSubagents(task: {
  craftbook: { renderedAs?: 'outcome' | undefined };
  strategyOptions?: TaskStrategyOptions | undefined;
}): boolean {
  return isOutcomeTask(task) && task.strategyOptions?.subagents !== false;
}

/**
 * The teammates an outcome task's owner may consult, by the slug of their
 * `consult_<slug>` tool. Doer roles only: the owner coordinates the task, so
 * handing it to a voorman or the Meester would hand away the coordination.
 */
export const OUTCOME_TEAMMATE_SLUGS = [
  'researcher',
  'reviewer',
  'writer',
  'developer',
  'planner',
  'designer',
] as const;
export type OutcomeTeammateSlug = (typeof OUTCOME_TEAMMATE_SLUGS)[number];

/** The job title a teammate is recruited by, matching the `consult_<slug>` tools. */
export const OUTCOME_TEAMMATE_JOB_TITLES: Readonly<Record<OutcomeTeammateSlug, string>> = {
  researcher: 'Researcher',
  reviewer: 'Reviewer',
  writer: 'Copywriter',
  developer: 'Developer',
  planner: 'Planner',
  designer: 'Designer',
};

export const OUTCOME_TEAMMATE_TOOLS: readonly string[] = OUTCOME_TEAMMATE_SLUGS.map(
  (slug) => `consult_${slug}`,
);
