import {
  DEFAULT_NIGHT_SHIFT_WINDOW,
  type GezelConfig,
  type NightShiftWindow,
  type Task,
  createLogger,
  isInNightShiftWindow,
  isPendingNightShiftTask,
  lastNightShiftWindow,
  localDateKey,
  nextNightShiftStart,
  nightShiftDayKey,
  nightShiftWindowBounds,
  nightShiftWindowKey,
  projectAllowsAmbientWork,
} from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import type { Store } from '../fs/store.js';
import type { ProviderName } from '../providers/types.js';
import { type TaskManager, stepOwnerGezelId } from './manager.js';
import type { QuotaReserveHold } from './night-quota-gate.js';

const log = createLogger('night-shift');

export type NightShiftSource = 'scheduled' | 'manual' | null;

/**
 * What the Electron shell needs to know to drive OS power. Read over the
 * existing one-way idle poll (`GET /api/night-shift/power-intent`):
 *   - `keepAwake` — hold a power-save blocker while night-shift work runs.
 *   - `wakeAtIso` — pre-arm an OS wake for the next window start, or null.
 */
export interface NightShiftPowerIntent {
  keepAwake: boolean;
  wakeAtIso: string | null;
}

export interface NightShiftManagerOptions {
  store: Store;
  manager: TaskManager;
  events: ChatEventBus;
  intervalMs?: number;
  /** Clock override for tests. */
  now?: () => Date;
  /** Quota-reserve verdicts (NightShiftQuotaGate); absent = never hold. */
  quotaGate?: { holdFor(provider: ProviderName): Promise<QuotaReserveHold | null> };
  /**
   * Night-aware provider resolution — the same `chat.providerForGezel`
   * closure the runner's dispatcher uses, so classification here and
   * admission there cannot disagree. Absent = the gate never applies.
   */
  resolveProviderName?: (gezelId: string, opts?: { nightShift?: boolean }) => Promise<ProviderName>;
}

/** Why pending night work is parked, summarized for status surfaces. */
export interface NightShiftQuotaHoldStatus {
  heldTaskCount: number;
  /** One reason per affected provider. */
  reasons: QuotaReserveHold[];
}

const TICK_INTERVAL_MS = 30_000;

/**
 * Owns the Night Shift ON/OFF state. Lifecycle mirrors `TaskScheduler` /
 * `IndexEnrichmentManager`: an unref'd interval that recomputes a single
 * boolean each tick. Nothing here is persisted — the active flag is
 * derived from config (window/flags) + live task state, so a restart
 * recomputes from scratch.
 *
 * Decision per tick (after the master `enabled` gate):
 *   - A MANUAL shift ignores the window + latch, staying active until no
 *     pending night-shift tasks remain, then reverts to scheduled logic.
 *   - SCHEDULED: outside the window → off (latch cleared); window open but
 *     no pending work → latch off for the rest of THIS window; otherwise on.
 *   - QUOTA-HELD: pending work whose resolved provider is inside the cloud
 *     quota reserve doesn't keep a shift alive. All pending work held →
 *     off WITHOUT latching (parked, not drained) so a mid-window quota
 *     reset re-activates on a later tick; a manual request survives the
 *     hold and resumes by itself. `quotaHoldStatus()` names the parked
 *     state for the UI.
 *
 * Consumers read `isActive()` synchronously: `TaskRunner` (dispatch gating
 * + priority), `TaskScheduler` (cron-spawn gating), `IndexEnrichmentManager`
 * (idle-gate relaxation).
 */
export class NightShiftManager {
  private readonly store: Store;
  private readonly manager: TaskManager;
  private readonly events: ChatEventBus;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly quotaGate?: {
    holdFor(provider: ProviderName): Promise<QuotaReserveHold | null>;
  };
  private readonly resolveProviderName?: (
    gezelId: string,
    opts?: { nightShift?: boolean },
  ) => Promise<ProviderName>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  private active = false;
  private src: NightShiftSource = null;
  /** When the running shift began; null while nothing is running. */
  private startedAt: string | null = null;
  /** Window key we've drained-and-latched off for; cleared next window. */
  private latchedOffForWindowKey: string | null = null;
  /** Whether a manual ("go to lunch") shift has been requested. */
  private manualRequested = false;

  private keepAwake = false;
  private wakeAtIso: string | null = null;
  /** Whether the configured window is currently open (cached each tick). */
  private windowOpen = false;
  /** Master feature flag from the last tick — drives the synchronous reads. */
  private enabled = true;
  /** Window config from the last tick — drives the synchronous day-key. */
  private window: NightShiftWindow = DEFAULT_NIGHT_SHIFT_WINDOW;
  /** Quota-reserve hold summary from the last tick; null when nothing is held. */
  private quotaHold: NightShiftQuotaHoldStatus | null = null;
  /** Refs of pending night tasks the quota reserve is holding, per last tick. */
  private quotaHeldRefs = new Set<string>();

  constructor(opts: NightShiftManagerOptions) {
    this.store = opts.store;
    this.manager = opts.manager;
    this.events = opts.events;
    this.intervalMs = opts.intervalMs ?? TICK_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    this.quotaGate = opts.quotaGate;
    this.resolveProviderName = opts.resolveProviderName;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        log.warn('[night-shift] tick failed:', err instanceof Error ? err.message : err),
      );
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isActive(): boolean {
    return this.active;
  }

  source(): NightShiftSource {
    return this.src;
  }

  /**
   * When the running shift began, or null when nothing is running. This is
   * the ON edge, not the window's opening hour: a scheduled shift starts on
   * the tick that turned it on, which is later than `startHour` whenever the
   * machine was asleep or the work only arrived mid-window. A shift that
   * changes source mid-run (a scheduled window taking over from a manual
   * one) keeps its original start — it never stopped running.
   */
  startedAtIso(): string | null {
    return this.startedAt;
  }

  /**
   * The scheduled window status surfaces name: the one open right now, else
   * the next one due. Null while the feature is switched off — nothing is
   * scheduled, so there is no window to name. Uses the window config cached
   * from the last tick.
   */
  windowBounds(): { start: string; end: string; open: boolean } | null {
    if (!this.enabled) return null;
    const bounds = nightShiftWindowBounds(this.now(), this.window);
    return {
      start: bounds.start.toISOString(),
      end: bounds.end.toISOString(),
      open: bounds.open,
    };
  }

  /**
   * Why pending night work is parked by the cloud quota reserve, as of the
   * last tick — null when nothing is held. Non-null both while the shift
   * runs with a subset held (mixed providers) and while it sits fully
   * parked (active=false, no latch) waiting for a quota window to reset.
   */
  quotaHoldStatus(): NightShiftQuotaHoldStatus | null {
    return this.quotaHold;
  }

  /** Refs of the pending night tasks currently held by the quota reserve. */
  quotaHeldTaskRefs(): ReadonlySet<string> {
    return this.quotaHeldRefs;
  }

  /**
   * Whether the configured nightly window is open right now — used by the
   * scheduler to confine a night-shift cron host's spawning to the window
   * (independent of whether the shift is actively draining work). Reflects
   * the last tick; recomputed every 30s.
   */
  isWindowOpen(): boolean {
    return this.windowOpen;
  }

  /**
   * The current night-window day key (window-start local date inside a
   * window, plain local date outside). Drives the scheduler's
   * once-per-window guard on night-shift spawn hosts. Uses the window
   * cached from the last tick.
   */
  currentDayKey(): string {
    return nightShiftDayKey(this.now(), this.window);
  }

  /** The window config cached from the last tick. */
  currentWindow(): NightShiftWindow {
    return this.window;
  }

  /**
   * When the next scheduled window opens, or null while the feature is
   * switched off. Distinct from `getPowerIntent().wakeAtIso`, which is
   * additionally gated on `wakeOnStart` because it arms an OS wake — this
   * one is just the clock time, for telling the user when parked
   * night-shift work will pick up.
   */
  nextStartIso(): string | null {
    if (!this.enabled) return null;
    return nextNightShiftStart(this.now(), this.window).toISOString();
  }

  /**
   * Register the window-settled callback — invoked (fire-and-forget)
   * whenever a night window is behind us: on the open→closed transition
   * AND on the first tick after startup when the machine slept through
   * the window's end. In-process dedup by window key; the callee dedups
   * durably (the morning question's `windowKey` intent), so a restart
   * re-invoking it is harmless. Wired late by service.ts (the review
   * builder depends on managers constructed after this one).
   */
  setOnWindowSettled(fn: (windowKey: string) => Promise<void>): void {
    this.onWindowSettled = fn;
  }
  private onWindowSettled?: (windowKey: string) => Promise<void>;
  private settledNotifiedKey: string | null = null;

  /**
   * Register late-bound work reconciliation for each OFF → ON transition.
   * Awaited so manual start wakes real work before its response is returned.
   */
  setOnActivated(fn: () => Promise<void>): void {
    this.onActivated = fn;
  }
  private onActivated?: () => Promise<void>;

  /**
   * Whether `task` still has night-shift work to do today — false for a
   * `onceADay` task whose `lastRunDay` is today's window-start date. Used
   * by the runner to hold a daily task after its single run. Uses the
   * window cached from the last tick.
   */
  isPendingToday(task: Task): boolean {
    return isPendingNightShiftTask(task, nightShiftDayKey(this.now(), this.window));
  }

  getPowerIntent(): NightShiftPowerIntent {
    return { keepAwake: this.keepAwake, wakeAtIso: this.wakeAtIso };
  }

  /** Manually start a shift now (e.g. user stepping out). */
  async startManual(): Promise<void> {
    this.manualRequested = true;
    // Clear any user stop-latch: an explicit start is the user opting back
    // in, so the shift should run even if they'd stopped this window earlier.
    this.latchedOffForWindowKey = null;
    await this.tick();
  }

  /**
   * Manually end a shift. Beyond clearing the manual request, this latches
   * the currently-open scheduled window OFF so the next tick doesn't just
   * re-activate the shift — stopping mid-window is a deliberate "not tonight"
   * that should stick until the window closes (the latch clears with it) or
   * the user explicitly starts again ({@link startManual} clears the latch).
   */
  async stopManual(): Promise<void> {
    this.manualRequested = false;
    const windowKey = nightShiftWindowKey(this.now(), this.window);
    if (windowKey !== null) this.latchedOffForWindowKey = windowKey;
    await this.tick();
  }

  /** Public for tests: run one decision pass. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.decide();
    } finally {
      this.ticking = false;
    }
  }

  private async decide(): Promise<void> {
    const cfg = await this.store.readConfig().catch(() => ({}) as GezelConfig);
    const ns = cfg.nightShift ?? {};
    const enabled = ns.enabled !== false;
    const window = ns.window ?? DEFAULT_NIGHT_SHIFT_WINDOW;
    this.window = window;
    this.enabled = enabled;
    const now = this.now();
    this.windowOpen = enabled && isInNightShiftWindow(now, window);

    // Pre-arm the next OS wake regardless of the current active state — the
    // machine may be asleep when the window opens, so the wake must already
    // be scheduled. Cleared when the feature/flag is off.
    this.wakeAtIso =
      enabled && ns.wakeOnStart ? nextNightShiftStart(now, window).toISOString() : null;

    let active = false;
    let src: NightShiftSource = null;
    let quotaHeld: Array<{ task: Task; hold: QuotaReserveHold }> = [];

    if (enabled) {
      const windowKey = nightShiftWindowKey(now, window);
      const todayKey = windowKey ?? localDateKey(now);
      const pendingTasks = await this.pendingNightShiftTasks(todayKey);
      const pending = pendingTasks.length > 0;

      // Classify only when the outcome can matter — a shift that could
      // otherwise turn ON this tick. Daytime and latched-off windows skip
      // the gate so no quota probe ever runs outside a shift.
      const couldActivate =
        pending &&
        (this.manualRequested || (windowKey !== null && this.latchedOffForWindowKey !== windowKey));
      const { dispatchable, held } = couldActivate
        ? await this.classifyPending(pendingTasks)
        : { dispatchable: pendingTasks, held: [] };
      quotaHeld = held;
      const hasDispatchable = dispatchable.length > 0;

      if (this.manualRequested) {
        if (!pending) {
          // Manual shift drained — revert: fall through to scheduled logic.
          this.manualRequested = false;
        } else if (hasDispatchable) {
          active = true;
          src = 'manual';
        }
        // else: everything is quota-held. Keep the request — the user asked
        // for this shift, so it resumes by itself when quota frees; stopManual
        // remains the way out. Not active, so keepAwake releases below.
      }

      if (!active && !this.manualRequested) {
        if (windowKey === null) {
          this.latchedOffForWindowKey = null; // outside window: clear latch
        } else if (this.latchedOffForWindowKey === windowKey) {
          // already drained this window — stay off
        } else if (!pending) {
          this.latchedOffForWindowKey = windowKey; // latch off for the rest of the window
        } else if (!hasDispatchable) {
          // Quota-held, NOT drained: off this tick but deliberately no latch
          // — a five_hour bucket can reset mid-window, and the next tick must
          // re-activate (firing onActivated to rehydrate + wake the runner).
        } else {
          active = true;
          src = 'scheduled';
        }
      }
    }

    this.quotaHeldRefs = new Set(quotaHeld.map((h) => h.task.ref));
    this.quotaHold =
      quotaHeld.length > 0
        ? {
            heldTaskCount: quotaHeld.length,
            reasons: dedupeHoldsByProvider(quotaHeld.map((h) => h.hold)),
          }
        : null;

    this.keepAwake = active && ns.keepAwakeWhileRunning === true;
    const activating = active && !this.active;
    this.setActive(active, src);
    if (activating && this.onActivated) {
      await this.onActivated().catch((err) => {
        log.warn(`[night-shift] activation callback failed: ${String(err)}`);
      });
    }

    // Morning-review trigger: whenever we're OUTSIDE the window, the most
    // recently completed window is "settled". Notify once per key —
    // covers both the live open→closed transition and waking up after
    // having slept through the window's end.
    if (enabled && !this.windowOpen && this.onWindowSettled) {
      const settledKey = lastNightShiftWindow(now, window).key;
      if (settledKey !== this.settledNotifiedKey) {
        this.settledNotifiedKey = settledKey;
        this.onWindowSettled(settledKey).catch((err) => {
          log.warn(`[night-shift] window-settled callback failed: ${String(err)}`);
        });
      }
    }
  }

  /**
   * The active night-shift tasks that still have work to do right now —
   * pending today AND in a project that allows ambient work. This is the
   * set `decide()` consults to keep a shift alive; {@link listPendingTasks}
   * exposes the same set for the UI's "what's the shift doing?" panel.
   */
  async listPendingTasks(): Promise<Task[]> {
    const now = this.now();
    const todayKey = nightShiftWindowKey(now, this.window) ?? localDateKey(now);
    return this.pendingNightShiftTasks(todayKey);
  }

  /**
   * Partition pending night tasks into dispatchable vs quota-held using
   * the same provider resolution the runner's dispatcher applies (night
   * override included). Optimistic on every failure path: a task whose
   * owner or provider can't resolve counts dispatchable — the runner
   * drops it later, and counting it held would wrongly deactivate the
   * shift. Verdicts are memoized per provider per pass.
   */
  private async classifyPending(tasks: Task[]): Promise<{
    dispatchable: Task[];
    held: Array<{ task: Task; hold: QuotaReserveHold }>;
  }> {
    const dispatchable: Task[] = [];
    const held: Array<{ task: Task; hold: QuotaReserveHold }> = [];
    const quotaGate = this.quotaGate;
    const resolveProviderName = this.resolveProviderName;
    if (!quotaGate || !resolveProviderName) {
      return { dispatchable: [...tasks], held };
    }
    const providerByGezel = new Map<string, ProviderName | null>();
    const holdByProvider = new Map<ProviderName, QuotaReserveHold | null>();
    for (const task of tasks) {
      const step = task.activeStepId
        ? task.craftbook.steps.find((s) => s.id === task.activeStepId)
        : undefined;
      const gezelId = step ? stepOwnerGezelId(task, step) : undefined;
      if (!gezelId) {
        dispatchable.push(task);
        continue;
      }
      let provider = providerByGezel.get(gezelId);
      if (provider === undefined) {
        provider = await resolveProviderName(gezelId, { nightShift: true }).catch(() => null);
        providerByGezel.set(gezelId, provider);
      }
      if (!provider) {
        dispatchable.push(task);
        continue;
      }
      let hold = holdByProvider.get(provider);
      if (hold === undefined) {
        hold = await quotaGate.holdFor(provider).catch(() => null);
        holdByProvider.set(provider, hold);
      }
      if (hold) held.push({ task, hold });
      else dispatchable.push(task);
    }
    return { dispatchable, held };
  }

  /** Active night-shift tasks pending `todayKey`, in `manager.list` order. */
  private async pendingNightShiftTasks(todayKey: string): Promise<Task[]> {
    const tasks = await this.manager.list({ status: 'active' }).catch(() => []);
    if (tasks.length === 0) return [];
    const out: Task[] = [];
    const allowsAmbient = new Map<string, boolean>();
    for (const t of tasks) {
      if (!isPendingNightShiftTask(t, todayKey)) continue;
      let ok = allowsAmbient.get(t.projectId);
      if (ok === undefined) {
        const project = await this.store.getProject(t.projectId).catch(() => null);
        ok = project ? projectAllowsAmbientWork(project) : true;
        allowsAmbient.set(t.projectId, ok);
      }
      if (ok) out.push(t);
    }
    return out;
  }

  /** Single transition chokepoint: diff, broadcast, log. */
  private setActive(next: boolean, src: NightShiftSource): void {
    if (this.active === next && this.src === src) return;
    // Stamp the period at the OFF → ON edge only, so a source change
    // mid-run (manual handing over to the scheduled window) doesn't restart
    // the clock the UI counts from.
    if (next && !this.active) this.startedAt = this.now().toISOString();
    else if (!next) this.startedAt = null;
    this.active = next;
    this.src = src;
    this.events.publishGlobalEvent({ type: 'night_shift', active: next, source: src });
    log.info(`[night-shift] ${next ? `ON (${src})` : 'OFF'}`);
  }
}

/** First hold per provider — one status line per affected provider. */
function dedupeHoldsByProvider(holds: QuotaReserveHold[]): QuotaReserveHold[] {
  const byProvider = new Map<ProviderName, QuotaReserveHold>();
  for (const hold of holds) {
    if (!byProvider.has(hold.provider)) byProvider.set(hold.provider, hold);
  }
  return [...byProvider.values()];
}
