import { type TaskCraftbookStep, type TaskExecutionMode, createLogger } from '@bendyline/gezel';
import { pinCraftbookOwner } from './craftbook-instantiation.js';

const log = createLogger('tasks');

/**
 * What the execution-mode resolver decided for a task. `ownerGezelId` is the
 * Generalist gezel to pin on every step of an auto-assigned generalist task;
 * absent when the caller pinned an owner (that gezel is the owner) or the
 * mode is stepwise. The remaining fields only feed the log marker the eval
 * harness reads (`generalist-mode resolved=…`).
 */
export interface ExecutionModeResolution {
  mode: TaskExecutionMode;
  ownerGezelId?: string;
  setting?: string;
  providerName?: string;
  tier?: string;
}

/**
 * Turns the install setting (`config.generalistMode`), a per-invocation
 * request, and the executing provider into the task's execution mode. Wired
 * by `product-service.ts`; see `core/generalist-mode.ts`. When unset, an
 * explicit request is honored as-is (no owner is minted) and `auto` means
 * stepwise. Errors are caught and treated as stepwise so a misconfigured
 * wiring never blocks task creation.
 */
export type ExecutionModeResolver = (args: {
  projectId: string;
  /** The caller's explicit owner, when the request pinned one. */
  assigneeGezelId?: string;
  nightShift?: boolean;
  requested: 'auto' | TaskExecutionMode;
}) => Promise<ExecutionModeResolution>;

export interface ApplyExecutionModeArgs {
  projectId: string;
  ref: string;
  craftbook: { steps: TaskCraftbookStep[] };
  spawnsCraftbook?: { steps: TaskCraftbookStep[] } | undefined;
  requested: 'auto' | TaskExecutionMode;
  assigneeGezelId?: string;
  nightShift?: boolean;
}

/**
 * Resolve a task's execution mode and, for a generalist task, pin its owner
 * on every step of the main book and the spawn template so no specialist is
 * recruited at any later activation. Callers run this BEFORE the entry
 * step's role resolution on purpose: resolving the role first would mint a
 * specialist the pin then discards. Best-effort — any failure resolves to
 * stepwise, the behavior every task had before generalist mode existed.
 */
export async function applyExecutionMode(
  resolver: ExecutionModeResolver | undefined,
  args: ApplyExecutionModeArgs,
): Promise<TaskExecutionMode> {
  let resolution: ExecutionModeResolution;
  try {
    resolution = resolver
      ? await resolver({
          projectId: args.projectId,
          requested: args.requested,
          ...(args.assigneeGezelId ? { assigneeGezelId: args.assigneeGezelId } : {}),
          ...(args.nightShift ? { nightShift: true } : {}),
        })
      : { mode: args.requested === 'auto' ? 'stepwise' : args.requested };
  } catch (err) {
    log.warn(
      `[tasks] ${args.ref} execution-mode resolution failed; running stepwise:`,
      err instanceof Error ? err.message : err,
    );
    resolution = { mode: 'stepwise' };
  }
  const owner =
    resolution.mode === 'generalist'
      ? (args.assigneeGezelId ?? resolution.ownerGezelId)
      : undefined;
  if (owner) {
    pinCraftbookOwner(args.craftbook.steps, owner);
    if (args.spawnsCraftbook) pinCraftbookOwner(args.spawnsCraftbook.steps, owner);
  }
  // Stable marker: the eval harness reads `resolved=`/`setting=` into its
  // continuity facts. Keep the shape if you reword the rest.
  log.info(
    `[tasks] ${args.ref} generalist-mode resolved=${resolution.mode} setting=${resolution.setting ?? 'auto'} provider=${resolution.providerName ?? 'unknown'} tier=${resolution.tier ?? 'unknown'} requested=${args.requested}${owner ? ` owner=${owner}` : ''}`,
  );
  return resolution.mode;
}
