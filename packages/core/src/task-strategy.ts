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
 * `auto` follows evidence: the strategy the benchmark measured for the model
 * that will run the task (its catalog `tuning.taskStrategy`, or for a hosted
 * model {@link HOSTED_MODEL_TASK_STRATEGIES}), else outcome without the recipe
 * on device and on a hosted frontier provider, and `generalistMode`'s task
 * rule for anything else. See docs/task-strategies.md.
 */
import {
  type GeneralistModeSetting,
  type TaskExecutionMode,
  isFrontierProvider,
  resolveTaskExecutionMode,
} from './generalist-mode.js';

/**
 * Providers whose unmeasured models run outcome without the recipe under
 * `auto`: the person's own engines and a paired device's. Every on-device
 * model the benchmark measured picked it (Gemma 4 E4B, Qwen 3.5 9B, Ornith
 * 1.5 9B and Qwen 3.8 27B, 2026-11-04), each beating stepwise at a third of
 * the wall time or less. Bare strings, like `FRONTIER_PROVIDER_NAMES`.
 */
export const ON_DEVICE_MODEL_PROVIDER_NAMES: ReadonlyArray<string> = [
  'llama-cpp',
  'mlx',
  'ds4',
  'ollama',
  'remote',
];

export const TASK_STRATEGIES = ['stepwise', 'generalist', 'outcome'] as const;
export type TaskStrategy = (typeof TASK_STRATEGIES)[number];
export type TaskStrategySetting = 'auto' | TaskStrategy;

/** Variants of the outcome strategy, used to separate its ingredients in evals. */
export interface TaskStrategyOptions {
  /** Show the recipe as advice (`advisory`, the default) or leave it out (`none`). */
  procedure?: 'advisory' | 'none';
  /** Let the owner hand self-contained pieces to teammates. Default true. */
  subagents?: boolean;
  /**
   * Eval only, to measure what the contract buys: `enforced` (the default)
   * shows and checks it; `shown` shows it and checks nothing; `hidden` keeps
   * it for grading but leaves the request as the only instruction.
   */
  contract?: TaskContractMode;
}

export type TaskContractMode = 'enforced' | 'shown' | 'hidden';

/** How a task's contract reaches its owner. See {@link TaskStrategyOptions.contract}. */
export function taskContractMode(task: {
  strategyOptions?: TaskStrategyOptions | undefined;
}): TaskContractMode {
  return task.strategyOptions?.contract ?? 'enforced';
}

/**
 * A model's measured strategy (catalog `tuning.taskStrategy`). Structural so
 * this module stays free of the schemas that import it.
 */
export interface ModelStrategyAffinity {
  strategy: TaskStrategy;
  procedure?: 'advisory' | 'none' | undefined;
}

/**
 * Measured strategies for hosted models, which have no Gilde catalog entry to
 * carry `tuning.taskStrategy`. Keyed `<provider>:<model id>`: a measurement is
 * of the model through that provider's tool loop, so the same model through
 * another provider (Copilot, the Claude CLI) stays unmeasured and gets the
 * provider default.
 *
 * - `anthropic:claude-sonnet-5-5`: recipe as advice matched one owner on every
 *   quality measure at 0.35x the wall time and about a quarter of the cost
 *   (18 books, 162 trials, 2026-11-09; evals/runs/frontier-2026-11-09/PREREG.md).
 * - `codex-cli:gpt-6.1-sol`: both goal-based strategies qualified against one
 *   owner, and goal only scored higher on judged quality than recipe as advice
 *   (18 books, 162 trials, 2026-11-10;
 *   evals/runs/frontier-sol-2026-11-09/PREREG.md).
 */
export const HOSTED_MODEL_TASK_STRATEGIES: Readonly<Record<string, ModelStrategyAffinity>> = {
  'anthropic:claude-sonnet-5-5': { strategy: 'outcome', procedure: 'advisory' },
  'codex-cli:gpt-6.1-sol': { strategy: 'outcome', procedure: 'none' },
};

/** A hosted model's measured strategy, or undefined when it was never measured. */
export function hostedModelTaskStrategy(
  providerName: string | undefined,
  modelId: string | undefined,
): ModelStrategyAffinity | undefined {
  if (!providerName || !modelId) return undefined;
  return HOSTED_MODEL_TASK_STRATEGIES[`${providerName}:${modelId}`];
}

export interface AutoTaskStrategy {
  strategy: TaskStrategy;
  /** Options the model's pick carries (outcome without a recipe). */
  options?: TaskStrategyOptions;
  /** Where the pick came from: the model's measurement, or the provider default. */
  source: 'model' | 'tier';
  /**
   * What to run when the pick cannot render for this book (outcome needs a
   * contract): `generalistMode`'s task rule, the choice `auto` made before
   * models had one.
   */
  fallback: TaskStrategy;
}

/**
 * `auto` for one model. An explicit `generalistMode` (`on` / `off`) is the
 * person's choice about task execution and wins over the model's
 * measurement; under `auto` the measurement wins. A model without one runs
 * outcome without the recipe on device and on a hosted frontier provider:
 * both frontier models measured (Sonnet 5.5, GPT-6.1 Sol, 2026-11-10) beat
 * one owner walking the recipe with a goal-based strategy, and goal only was
 * Sol's pick. Anything else (the mock provider, an unknown name) keeps
 * `generalistMode`'s task rule.
 */
export function resolveAutoTaskStrategy(args: {
  generalistMode?: GeneralistModeSetting | undefined;
  providerName: string | undefined;
  tier?: string | undefined;
  affinity?: ModelStrategyAffinity | undefined;
}): AutoTaskStrategy {
  const fallback = resolveTaskExecutionMode(args.generalistMode, args.providerName, args.tier);
  const measured =
    args.affinity && isTaskStrategy(args.affinity.strategy) ? args.affinity : undefined;
  const explicit = args.generalistMode === 'on' || args.generalistMode === 'off';
  if (!measured || explicit) {
    if (!explicit && defaultsToGoalOnly(args.providerName)) {
      return { strategy: 'outcome', options: { procedure: 'none' }, source: 'tier', fallback };
    }
    return { strategy: fallback, source: 'tier', fallback };
  }
  return {
    strategy: measured.strategy,
    ...(measured.strategy === 'outcome' && measured.procedure
      ? { options: { procedure: measured.procedure } }
      : {}),
    source: 'model',
    fallback,
  };
}

function defaultsToGoalOnly(providerName: string | undefined): boolean {
  return (
    ON_DEVICE_MODEL_PROVIDER_NAMES.includes(providerName ?? '') || isFrontierProvider(providerName)
  );
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
