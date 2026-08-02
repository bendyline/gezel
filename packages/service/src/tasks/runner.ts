/**
 * TaskRunner
 *
 * Paces step-handoff dispatches so a voorman advancing 50 tasks at
 * once doesn't blast 50 simultaneous LLM requests at the provider.
 * Sits between `TaskManager.completeStep` (which fires
 * `onStepActivated`) and `ChatManager.startHandoffSession` (which
 * spawns a session + sends).
 *
 * ## Flow
 *
 * Before this layer: the `onStepActivated` hook called
 * `chat.startHandoffSession` directly, producing one HTTP send per
 * advancement. Fine for 1–5 advancements, disastrous for 50.
 *
 * After this layer:
 *   1. Advancement fires → `enqueueHandoff(...)` appends a
 *      `PendingHandoff` to an in-memory queue.
 *   2. A ticker (default 5s) walks the queue in FIFO order and
 *      dispatches anything whose target provider has a free slot
 *      (`provider.queue.snapshot().running < concurrency`).
 *   3. Dispatched handoffs call `startHandoffSession` as before —
 *      but because that path now goes through the ProviderQueue,
 *      the actual LLM turn just inherits a normal slot reservation.
 *
 * ## Cancellation
 *
 * When a task transitions to `paused` / `complete` / `canceled`
 * while still queued, the next tick filters it out. No sessions
 * are spawned for work the user decided to abandon.
 *
 * ## Startup rehydration
 *
 * The queue is in-memory, but tasks are canonical on disk. On
 * service boot, `rehydrateFromStore` scans all `active` tasks and
 * enqueues a handoff for any whose current phase has an assignee
 * and no open session yet. This backfills pending work the
 * previous process was supposed to do before it stopped.
 */

import {
  type ModelTier,
  type Task,
  createLogger,
  isEngagementAllowed,
  projectAllowsAmbientWork,
  roleCapabilityFloor,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { LLMProvider, ProviderName } from '../providers/types.js';
import { mainBookSource, stepOwnerGezelId } from './manager.js';

const log = createLogger('tasks');

/**
 * Why a queued handoff didn't move on the last pass.
 *
 * `'night-shift'` is the one that is NOT a backlog: the work is parked
 * until tonight's window by design, so the UI files it under scheduled
 * work rather than counting it as something the user is waiting on.
 */
export type TaskHandoffHoldReason = 'engagement-off' | 'provider-busy';

export interface PendingHandoff {
  /** `{projectId}/{num}` ref of the task. */
  taskRef: string;
  stepId: string;
  /** Gezel the step is assigned to. */
  gezelId: string;
  projectId: string;
  /** Display name of the previous step's gezel, if any — used in the seed prompt. */
  fromGezelName?: string;
  /** `'entry'` for a fresh launch (no prior step); defaults to `'handoff'`. */
  kind?: 'handoff' | 'entry';
  /** Step activation timestamp captured when this handoff was enqueued. */
  activationAt?: string;
  enqueuedAt: number;
  /** Monotonic id for stable sort + debugging. */
  id: number;
  /**
   * Why this item is still on the queue, recomputed every tick.
   * `undefined` means "ready — it goes out as soon as a slot frees".
   *
   * Seeded at enqueue from the caller's `nightShift` flag so a night task
   * activated during the day is filed as scheduled work immediately,
   * rather than counting as a backlog item for the up-to-one-tick window
   * before the first `tick` reads it back off disk.
   */
  heldFor?: 'night-shift' | 'provider-busy';
}

/** One side of the pending split — see {@link TaskRunner.snapshot}. */
export interface TaskHandoffBucket {
  count: number;
  byGezel: Record<string, number>;
}

export interface TaskRunnerDispatcher {
  /**
   * Actually kick off the handoff. Called by the runner when a slot
   * frees up on the target provider. In production this wraps
   * `ChatManager.startHandoffSession`.
   */
  startHandoffSession(args: {
    gezelId: string;
    projectId: string;
    taskRef: string;
    stepId: string;
    fromGezelName?: string;
    kind?: 'handoff' | 'entry';
    /**
     * Queue lane for the dispatched turn. Night-shift handoffs travel
     * `'background'` so any interactive turn on the same provider preempts
     * them; normal handoffs default to `'interactive'`.
     */
    lane?: 'interactive' | 'background';
    /** Ambient handoff (night shift) — see `EnqueueRequest.ambient`. */
    ambient?: boolean;
    /** Apply the install's Night Shift provider/model defaults. */
    nightShift?: boolean;
    /**
     * Effective capability floor for the step — derived at dispatch as
     * `step.capabilityFloor ?? roleCapabilityFloor(step.suggestedRole)`.
     * When set, ChatManager routes the worker session to the cheapest
     * installed local model that clears it (see chat/model-routing.ts).
     * Absent → normal model resolution, no routing.
     */
    capabilityFloor?: ModelTier;
    /** Book join key for per-model gate evidence in the routing ranker. */
    bookCatalogId?: string;
  }): Promise<{ sessionId: string }>;

  /** Cancel a dispatched handoff whose task/activation is no longer current. */
  cancelHandoffSession?(sessionId: string): Promise<{ cancelled: boolean }>;

  /** True while the dispatched handoff's first turn is queued or running. */
  isHandoffSessionActive?(sessionId: string): boolean | Promise<boolean>;

  /**
   * Look up the provider name the target gezel resolves to — the runner
   * needs this to pick the right queue for backpressure decisions.
   */
  resolveProviderName(gezelId: string, opts?: { nightShift?: boolean }): Promise<ProviderName>;

  /**
   * Fetch a provider by name so the runner can read `queue.snapshot()`.
   * Returning `null` means "no queue yet; safe to dispatch." Providers
   * without a queue (MockProvider) dispatch unconditionally — tests
   * need the work to flow.
   */
  getProvider(name: ProviderName): LLMProvider | null;
}

export interface TaskRunnerOptions {
  store: Store;
  dispatcher: TaskRunnerDispatcher;
  /**
   * Tick cadence. 5000ms is plenty — a tick too fast is noise; too
   * slow and the queue feels sluggish after a provider drains.
   */
  tickIntervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /**
   * Synchronous read of Night Shift active state. While OFF, handoffs for
   * night-shift tasks are held on the queue rather than dispatched.
   * Defaults to always-off.
   */
  isNightShiftActive?: () => boolean;
  /**
   * Whether a night-shift task still has work to do TODAY — false for a
   * `onceADay` task that already ran (its `lastRunDay` is today). Lets a
   * self-looping daily task (e.g. the meester oversight) be held after its
   * single daily run instead of re-dispatching in a tight loop. Defaults
   * to "always pending" (only the active-shift gate applies).
   */
  isNightShiftPending?: (task: Task) => boolean;
}

export class TaskRunner {
  private readonly store: Store;
  private readonly dispatcher: TaskRunnerDispatcher;
  private readonly tickIntervalMs: number;
  private readonly now: () => number;
  private readonly isNightShiftActive: () => boolean;
  private readonly isNightShiftPending: (task: Task) => boolean;
  private readonly pending: PendingHandoff[] = [];
  private readonly activeDispatches = new Map<
    string,
    {
      sessionId: string;
      taskRef: string;
      stepId: string;
      gezelId: string;
      activationAt?: string;
    }
  >();
  private nextId = 1;
  /** Why `dispatchable` work isn't moving, as of the last tick. */
  private holdReason: TaskHandoffHoldReason | undefined;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Resolves while a tick is in flight — prevents overlapping ticks. */
  private tickInFlight: Promise<void> | null = null;

  constructor(opts: TaskRunnerOptions) {
    this.store = opts.store;
    this.dispatcher = opts.dispatcher;
    this.tickIntervalMs = opts.tickIntervalMs ?? 5_000;
    this.now = opts.now ?? Date.now;
    this.isNightShiftActive = opts.isNightShiftActive ?? (() => false);
    this.isNightShiftPending = opts.isNightShiftPending ?? (() => true);
  }

  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      void this.wake();
    }, this.tickIntervalMs);
    // Node's `setInterval` keeps the event loop alive — unref so this
    // doesn't block process shutdown in CLI contexts.
    this.ticker.unref?.();
  }

  async stop(): Promise<void> {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (this.tickInFlight) await this.tickInFlight;
  }

  enqueueHandoff(
    handoff: Omit<PendingHandoff, 'enqueuedAt' | 'id' | 'heldFor'> & {
      /**
       * Whether the task carries `nightShift.enabled`. Callers have the task
       * in hand; passing it lets the snapshot classify the item as scheduled
       * work from the moment it lands instead of one tick later.
       */
      nightShift?: boolean;
    },
  ): void {
    const key = handoffKey(handoff);
    if (this.pending.some((existing) => handoffKey(existing) === key)) {
      log.debug(`[task-runner] duplicate pending handoff suppressed: ${key}`);
      return;
    }
    const { nightShift, ...rest } = handoff;
    this.pending.push({
      ...rest,
      ...(nightShift && !this.isNightShiftActive() ? { heldFor: 'night-shift' as const } : {}),
      enqueuedAt: this.now(),
      id: this.nextId++,
    });
  }

  /**
   * Transfer an already-running dispatch to a fresh activation of the same
   * task step. Completion-gate self-loops driven by the active model turn do
   * not enqueue a replacement handoff—the current turn consumes the verdict
   * and repairs the deliverable—so the dispatch must follow the new
   * `lastActivatedAt`. Otherwise `pruneActiveDispatches` treats it as
   * superseded and aborts the healthy recovery turn.
   *
   * Returns true when a matching live dispatch was found. Sessions started
   * outside TaskRunner are intentionally a no-op.
   */
  adoptActiveDispatchActivation(args: {
    taskRef: string;
    stepId: string;
    gezelId: string;
    activationAt: string;
  }): boolean {
    let adopted = false;
    for (const [key, dispatch] of [...this.activeDispatches]) {
      if (
        dispatch.taskRef !== args.taskRef ||
        dispatch.stepId !== args.stepId ||
        dispatch.gezelId !== args.gezelId
      ) {
        continue;
      }
      const next = { ...dispatch, activationAt: args.activationAt };
      const nextKey = handoffKey({
        taskRef: next.taskRef,
        stepId: next.stepId,
        gezelId: next.gezelId,
        activationAt: next.activationAt,
      });
      if (nextKey !== key) this.activeDispatches.delete(key);
      this.activeDispatches.set(nextKey, next);
      adopted = true;
      log.debug(
        `[task-runner] active dispatch ${dispatch.sessionId} adopted ` +
          `${args.taskRef}/${args.stepId} activation ${args.activationAt}`,
      );
    }
    return adopted;
  }

  /**
   * Current queue state. Useful for tests and for the nudge-
   * suppression check that wants to ask "is there handoff work
   * already queued for this voorman?"
   *
   * `pending*` are the totals — every item on the queue, whatever is
   * holding it. They are split into two buckets because the two mean
   * very different things to a user:
   *
   *   - `dispatchable` — work waiting on a free provider slot. This is a
   *     real backlog and is what the header's Tasks chip counts.
   *   - `scheduled` — night-shift work parked until the next window. It
   *     is not waiting on anything and nobody needs to act on it, so
   *     surfacing it as a pending count all day reads as a stuck queue.
   *     Belongs in the Night Shift menu, not in a badge.
   */
  snapshot(): {
    pendingCount: number;
    pendingByGezel: Record<string, number>;
    pendingByProject: Record<string, number>;
    dispatchable: TaskHandoffBucket;
    scheduled: TaskHandoffBucket;
    holdReason?: TaskHandoffHoldReason;
  } {
    const byGezel: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    const dispatchable: TaskHandoffBucket = { count: 0, byGezel: {} };
    const scheduled: TaskHandoffBucket = { count: 0, byGezel: {} };
    for (const h of this.pending) {
      byGezel[h.gezelId] = (byGezel[h.gezelId] ?? 0) + 1;
      byProject[h.projectId] = (byProject[h.projectId] ?? 0) + 1;
      const bucket = h.heldFor === 'night-shift' ? scheduled : dispatchable;
      bucket.count += 1;
      bucket.byGezel[h.gezelId] = (bucket.byGezel[h.gezelId] ?? 0) + 1;
    }
    return {
      pendingCount: this.pending.length,
      pendingByGezel: byGezel,
      pendingByProject: byProject,
      dispatchable,
      scheduled,
      ...(dispatchable.count > 0 && this.holdReason ? { holdReason: this.holdReason } : {}),
    };
  }

  /** Task refs represented by the runner right now. */
  workSnapshot(): { queuedTaskRefs: string[]; dispatchedTaskRefs: string[] } {
    return {
      queuedTaskRefs: [...new Set(this.pending.map((handoff) => handoff.taskRef))],
      dispatchedTaskRefs: [...new Set([...this.activeDispatches.values()].map((d) => d.taskRef))],
    };
  }

  /** Run one serialized dispatch pass now, sharing the interval's overlap guard. */
  async wake(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.tick().finally(() => {
      this.tickInFlight = null;
    });
    return this.tickInFlight;
  }

  /**
   * Scan every `active` task and enqueue a handoff for any whose
   * current step has an effective gezel owner. Call on service boot and
   * whenever Night Shift opens to backfill work lost across a restart or an
   * earlier failed send.
   *
   * Safe to call more than once — duplicates are filtered via the
   * (taskRef, stepId, gezelId) triple before dispatch inside
   * `tick`, so a double-enqueue won't produce two handoff sessions.
   */
  async rehydrateFromStore(opts: { nightShiftOnly?: boolean } = {}): Promise<void> {
    const projects = await this.store.listProjects();
    for (const proj of projects) {
      // Skip projects whose status gates ambient work. Prevents stale
      // pending handoffs from an inactive project auto-resuming after
      // the service restarts.
      if (!projectAllowsAmbientWork(proj)) continue;
      const tasks = await this.store.listProjectTasks(proj.id).catch(() => []);
      for (const task of tasks) {
        if (task.status !== 'active') continue;
        if (opts.nightShiftOnly && task.nightShift?.enabled !== true) continue;
        if (!task.activeStepId) continue;
        const step = task.craftbook.steps.find((s) => s.id === task.activeStepId);
        if (!step) continue;
        const assigneeId = stepOwnerGezelId(task, step);
        if (!assigneeId) continue;
        // Persisted sessions are history, not evidence of live process work.
        // A failed handoff remains non-archived, and treating it as "live"
        // strands the active task forever after restart. enqueueHandoff plus
        // tick's activeDispatches check provide the in-process dedupe.
        this.enqueueHandoff({
          taskRef: task.ref,
          stepId: step.id,
          gezelId: assigneeId,
          projectId: proj.id,
          ...(task.nightShift?.enabled === true ? { nightShift: true as const } : {}),
          ...(step.lastActivatedAt ? { activationAt: step.lastActivatedAt } : {}),
        });
      }
    }
  }

  /**
   * One dispatch pass. Walks pending in FIFO order; dispatches any
   * whose target provider has a free slot; skips items for tasks
   * that are no longer active. Public for test-driven ticks.
   */
  async tick(): Promise<void> {
    await this.pruneActiveDispatches();
    if (this.pending.length === 0) {
      this.holdReason = undefined;
      return;
    }
    // Engagement mode "off" pauses dispatch — leave items on the queue so
    // they pick back up the moment the user flips engagement on.
    const config = await this.store.readConfig().catch(() => ({}));
    if (!isEngagementAllowed(config)) {
      this.holdReason = 'engagement-off';
      return;
    }

    // Work on a snapshot: mutating `pending` mid-loop from async
    // dispatches would thrash the iteration.
    const snapshot = this.pending.slice();
    const keep: PendingHandoff[] = [];
    // Dispatches within this tick haven't acquired queue slots yet
    // (startHandoffSession spawns a session; sendAndWait-via-queue
    // fires in the background). `snapshot().running` therefore
    // lags until those sends acquire. Count our own dispatches per
    // provider so we don't over-dispatch within a single tick.
    const inTickDispatches = new Map<ProviderName, number>();

    // Pre-pass: validate each handoff (still active, step current) and
    // partition into normal vs. night-shift work. Reading the task here
    // also lets the dispatch loop reuse it (no second read). Night-shift
    // handoffs are dispatched LAST so a queued interactive handoff always
    // wins a free provider slot ahead of deferrable batch work.
    const nightShiftOn = this.isNightShiftActive();
    const normalItems: PendingHandoff[] = [];
    const nightItems: PendingHandoff[] = [];
    const taskByHandoffId = new Map<number, Task>();
    const seenSnapshotKeys = new Set<string>();
    for (const handoff of snapshot) {
      // Status check: has the task moved out of 'active' while we
      // waited? Or been deleted entirely? Drop it either way.
      const [projectId, numStr] = handoff.taskRef.split('/');
      const num = Number(numStr);
      if (!projectId || !Number.isFinite(num)) {
        continue; // malformed — drop.
      }
      const task = await this.store.readTask(projectId, num).catch(() => null);
      if (!task || task.status !== 'active' || task.activeStepId !== handoff.stepId) {
        continue;
      }
      const currentStep = task.craftbook.steps.find((step) => step.id === handoff.stepId);
      if (
        handoff.activationAt &&
        currentStep?.lastActivatedAt &&
        currentStep.lastActivatedAt !== handoff.activationAt
      ) {
        continue;
      }
      const key = handoffKey({
        ...handoff,
        activationAt: handoff.activationAt ?? currentStep?.lastActivatedAt,
      });
      if (seenSnapshotKeys.has(key) || this.activeDispatches.has(key)) continue;
      seenSnapshotKeys.add(key);
      taskByHandoffId.set(handoff.id, task);
      if (task.nightShift?.enabled === true) nightItems.push(handoff);
      else normalItems.push(handoff);
    }

    for (const handoff of [...normalItems, ...nightItems]) {
      const task = taskByHandoffId.get(handoff.id)!;
      const isNight = nightItems.includes(handoff);
      // Night-shift task: hold on the queue unless the shift is ON and the
      // task still has work to do today (a `onceADay` task that already ran
      // is held until tomorrow). Already-dispatched night turns are
      // unaffected — the runner only controls queue admission — so in-flight
      // work wraps up while queued night work waits for the shift /
      // interactive work to drain.
      if (isNight && (!nightShiftOn || !this.isNightShiftPending(task))) {
        handoff.heldFor = 'night-shift';
        keep.push(handoff);
        continue;
      }

      // Backpressure check: does the target provider have room? If
      // not, put the handoff back on the queue and move on — the
      // next tick will revisit.
      const providerName = await this.dispatcher
        .resolveProviderName(handoff.gezelId, isNight ? { nightShift: true } : undefined)
        .catch(() => {
          // If resolution fails (e.g., gezel deleted), drop silently.
          return null;
        });
      if (!providerName) continue;
      const provider = this.dispatcher.getProvider(providerName);
      if (provider?.queue) {
        const snap = provider.queue.snapshot();
        const inFlight = inTickDispatches.get(providerName) ?? 0;
        // Hold off when the provider is at its cap. Dispatching
        // anyway would spawn a session whose acquire just blocks in
        // the queue — but keeping the handoff pending here lets
        // status-change cancellation (paused/canceled tasks) drop
        // work cleanly before a session is ever created.
        if (snap.running + inFlight >= provider.queue.concurrency) {
          handoff.heldFor = 'provider-busy';
          keep.push(handoff);
          continue;
        }
      }
      handoff.heldFor = undefined;

      // Effective capability floor, derived at dispatch (not enqueue)
      // so it covers every enqueue source — activation hook, command
      // launcher, and boot rehydration — and reads the PERSISTED step
      // (maybeResolveStepRole keeps `suggestedRole` intact when it
      // stamps `suggestedGezelId`, so the role is available here).
      const step = task.craftbook?.steps.find((s) => s.id === handoff.stepId);
      const floor = step?.capabilityFloor ?? roleCapabilityFloor(step?.suggestedRole) ?? undefined;

      // Dispatch. `startHandoffSession` is itself fire-and-forget
      // internally (spawns a session, detaches the first send), so
      // it returns quickly and we can move on to the next pending.
      try {
        const started = await this.dispatcher.startHandoffSession({
          gezelId: handoff.gezelId,
          projectId: handoff.projectId,
          taskRef: handoff.taskRef,
          stepId: handoff.stepId,
          ...(handoff.fromGezelName ? { fromGezelName: handoff.fromGezelName } : {}),
          ...(handoff.kind ? { kind: handoff.kind } : {}),
          ...(isNight ? { lane: 'background' as const, ambient: true } : {}),
          ...(isNight ? { nightShift: true } : {}),
          ...(floor
            ? { capabilityFloor: floor, bookCatalogId: mainBookSource(task).catalogId }
            : {}),
        });
        const activationAt =
          handoff.activationAt ??
          task.craftbook.steps.find((candidate) => candidate.id === handoff.stepId)
            ?.lastActivatedAt;
        const key = handoffKey({ ...handoff, activationAt });
        this.activeDispatches.set(key, {
          sessionId: started.sessionId,
          taskRef: handoff.taskRef,
          stepId: handoff.stepId,
          gezelId: handoff.gezelId,
          ...(activationAt ? { activationAt } : {}),
        });
        inTickDispatches.set(providerName, (inTickDispatches.get(providerName) ?? 0) + 1);
      } catch (err) {
        log.error(
          `[task-runner] dispatch failed for ${handoff.taskRef}/${handoff.stepId}:`,
          err instanceof Error ? err.message : err,
        );
        // On failure we drop — retrying indefinitely would loop on a
        // permanent fault (deleted gezel, bad config). The task stays
        // active on disk so a user can retry via `advance_task_step`
        // to re-enqueue.
      }
    }

    // Replace `pending` with the non-dispatched leftovers, preserving
    // the original order for anything we kept.
    this.pending.length = 0;
    this.pending.push(...keep);
    this.holdReason = keep.some((handoff) => handoff.heldFor === 'provider-busy')
      ? 'provider-busy'
      : undefined;
  }

  private async pruneActiveDispatches(): Promise<void> {
    for (const [key, dispatch] of this.activeDispatches) {
      const [projectId, numText] = dispatch.taskRef.split('/');
      const num = Number(numText);
      const task =
        projectId && Number.isFinite(num)
          ? await this.store.readTask(projectId, num).catch(() => null)
          : null;
      const step = task?.craftbook.steps.find((candidate) => candidate.id === dispatch.stepId);
      const stale =
        !task ||
        task.status !== 'active' ||
        task.activeStepId !== dispatch.stepId ||
        (dispatch.activationAt !== undefined && step?.lastActivatedAt !== dispatch.activationAt);
      if (stale) {
        // Distinguish WHY the dispatch went stale. The case to get right
        // is the dispatched worker finishing its OWN step: it called
        // `advance_task_step`, which flipped the task to `complete` (or
        // moved `activeStepId` past this step), and is now streaming its
        // closing words. Force-cancelling THAT aborts a healthy turn — the
        // worker self-cancels, the manager records an empty `turn-aborted`
        // message, and the tool calls it already committed vanish from the
        // session. So when staleness is the worker's own forward progress
        // AND its turn is still in flight, we don't cancel: we let the turn
        // finish and retire the tracking entry once it goes idle.
        //
        // Every other stale cause is a genuine supersession where the
        // displaced worker SHOULD stop, so we cancel it even mid-turn: the
        // task was paused or canceled out from under it, the task was
        // deleted, or the step was re-activated under a newer dispatch
        // (activation mismatch). An unrecognized status falls through to
        // cancel — the conservative default matching the prior behavior.
        const activationCurrent =
          dispatch.activationAt === undefined || step?.lastActivatedAt === dispatch.activationAt;
        const selfAdvanced =
          !!task &&
          activationCurrent &&
          (task.status === 'complete' ||
            (task.status === 'active' && task.activeStepId !== dispatch.stepId));
        if (selfAdvanced) {
          const stillInFlight = this.dispatcher.isHandoffSessionActive
            ? await this.dispatcher.isHandoffSessionActive(dispatch.sessionId)
            : false;
          if (!stillInFlight) this.activeDispatches.delete(key);
          continue;
        }
        await this.dispatcher.cancelHandoffSession?.(dispatch.sessionId).catch((err: unknown) => {
          log.warn(
            `[task-runner] failed to cancel stale handoff session ${dispatch.sessionId}:`,
            err instanceof Error ? err.message : err,
          );
        });
        this.activeDispatches.delete(key);
        continue;
      }
      if (this.dispatcher.isHandoffSessionActive) {
        const active = await this.dispatcher.isHandoffSessionActive(dispatch.sessionId);
        if (!active) this.activeDispatches.delete(key);
      }
    }
  }
}

function handoffKey(
  handoff: Pick<PendingHandoff, 'taskRef' | 'stepId' | 'gezelId' | 'activationAt'>,
): string {
  return `${handoff.taskRef}\u0000${handoff.stepId}\u0000${handoff.gezelId}\u0000${handoff.activationAt ?? ''}`;
}
