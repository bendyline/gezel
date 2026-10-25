import {
  type TaskCraftbook,
  type TaskExecutionMode,
  type TaskStrategy,
  type TaskStrategyOptions,
  type TaskStrategySetting,
  createLogger,
  executionModeForStrategy,
  outcomeRenderGap,
  renderCraftbookAsOutcome,
  withTerminalContractGate,
} from '@bendyline/gezel';
import { pinCraftbookOwner } from './craftbook-instantiation.js';

const log = createLogger('tasks');

/**
 * What the execution-mode resolver decided for a task. `ownerGezelId` is the
 * Generalist gezel to pin on every step of an auto-assigned generalist task;
 * absent when the caller pinned an owner (that gezel is the owner) or the
 * mode is stepwise. `strategy` is absent when it is just `mode`. The
 * remaining fields only feed the log marker the eval harness reads
 * (`generalist-mode resolved=…`).
 */
export interface ExecutionModeResolution {
  mode: TaskExecutionMode;
  strategy?: TaskStrategy;
  ownerGezelId?: string;
  setting?: string;
  providerName?: string;
  tier?: string;
}

/**
 * Turns the install settings (`config.taskStrategy`, `config.generalistMode`),
 * a per-invocation request, and the executing provider into the task's
 * strategy. Wired by `product-service.ts`; see `core/task-strategy.ts`. When
 * unset, an explicit request is honored as-is (no owner is minted) and `auto`
 * means stepwise. Errors are caught and treated as stepwise so a
 * misconfigured wiring never blocks task creation.
 */
export type ExecutionModeResolver = (args: {
  projectId: string;
  /** The caller's explicit owner, when the request pinned one. */
  assigneeGezelId?: string;
  nightShift?: boolean;
  requested: TaskStrategySetting;
}) => Promise<ExecutionModeResolution>;

export interface ApplyExecutionModeArgs {
  projectId: string;
  ref: string;
  craftbook: TaskCraftbook;
  spawnsCraftbook?: TaskCraftbook | undefined;
  requested: TaskStrategySetting;
  /**
   * The caller named this task's strategy. An outcome render that cannot run
   * is then an error; under an install setting it falls back to generalist.
   */
  explicit?: boolean;
  strategyOptions?: TaskStrategyOptions | undefined;
  assigneeGezelId?: string;
  nightShift?: boolean;
  now: string;
}

export interface AppliedExecutionMode {
  mode: TaskExecutionMode;
  strategy: TaskStrategy;
  craftbook: TaskCraftbook;
  spawnsCraftbook?: TaskCraftbook | undefined;
}

/**
 * Resolve a task's strategy and shape its book for it: an outcome task gets
 * the one-step outcome render, any other task with a contract gets the
 * contract on its terminal step. A generalist or outcome task then has its
 * owner pinned on every step of the main book and the spawn template, so no
 * specialist is recruited at any later activation. Callers run this BEFORE
 * activating the entry step (the render replaces it) and before the entry
 * step's role resolution (resolving the role first would mint a specialist
 * the pin then discards). A resolver failure resolves to stepwise, the
 * behavior every task had before generalist mode existed.
 */
export async function applyExecutionMode(
  resolver: ExecutionModeResolver | undefined,
  args: ApplyExecutionModeArgs,
): Promise<AppliedExecutionMode> {
  // Checked before resolving, so a refused request recruits no owner.
  if (args.explicit && args.requested === 'outcome') {
    const gap = outcomeRenderGap(args.craftbook, args.spawnsCraftbook);
    if (gap) throw new Error(`task ${args.ref} cannot run as an outcome: ${gap}`);
  }
  let resolution: ExecutionModeResolution;
  try {
    resolution = resolver
      ? await resolver({
          projectId: args.projectId,
          requested: args.requested,
          ...(args.assigneeGezelId ? { assigneeGezelId: args.assigneeGezelId } : {}),
          ...(args.nightShift ? { nightShift: true } : {}),
        })
      : {
          mode: args.requested === 'auto' ? 'stepwise' : executionModeForStrategy(args.requested),
          ...(args.requested === 'auto' ? {} : { strategy: args.requested }),
        };
  } catch (err) {
    log.warn(
      `[tasks] ${args.ref} execution-mode resolution failed; running stepwise:`,
      err instanceof Error ? err.message : err,
    );
    resolution = { mode: 'stepwise' };
  }
  let strategy: TaskStrategy = resolution.strategy ?? resolution.mode;
  let craftbook = args.craftbook;
  let spawnsCraftbook = args.spawnsCraftbook;
  if (strategy === 'outcome') {
    const rendered = renderCraftbookAsOutcome(craftbook, {
      spawnsCraftbook,
      options: args.strategyOptions,
      now: args.now,
    });
    if (rendered.ok) {
      craftbook = rendered.craftbook;
      spawnsCraftbook = undefined;
    } else if (args.explicit) {
      throw new Error(`task ${args.ref} cannot run as an outcome: ${rendered.reason}`);
    } else {
      log.warn(`[tasks] ${args.ref} runs generalist: ${rendered.reason}`);
      strategy = 'generalist';
    }
  }
  if (strategy !== 'outcome') {
    craftbook = withTerminalContractGate(craftbook);
    if (spawnsCraftbook) spawnsCraftbook = withTerminalContractGate(spawnsCraftbook);
  }
  const mode = executionModeForStrategy(strategy);
  const owner =
    mode === 'generalist' ? (args.assigneeGezelId ?? resolution.ownerGezelId) : undefined;
  if (owner) {
    pinCraftbookOwner(craftbook.steps, owner);
    if (spawnsCraftbook) pinCraftbookOwner(spawnsCraftbook.steps, owner);
  }
  // Stable marker: the eval harness reads `resolved=`/`setting=`/`strategy=`
  // into its continuity facts. Keep the shape if you reword the rest.
  log.info(
    `[tasks] ${args.ref} generalist-mode resolved=${mode} setting=${resolution.setting ?? 'auto'} provider=${resolution.providerName ?? 'unknown'} tier=${resolution.tier ?? 'unknown'} requested=${args.requested}${owner ? ` owner=${owner}` : ''} strategy=${strategy}`,
  );
  return { mode, strategy, craftbook, ...(spawnsCraftbook ? { spawnsCraftbook } : {}) };
}
