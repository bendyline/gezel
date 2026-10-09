import {
  DEFAULT_NIGHT_SHIFT_WINDOW,
  type GezelConfig,
  type NightShiftWindow,
  type Task,
  createLogger,
  isInNightShiftWindow,
  isNightShiftTask,
  isPendingNightShiftTask,
  lastNightShiftWindow,
  localDateKey,
  nextNightShiftStart,
  nightShiftDayKey,
  nightShiftWindowBounds,
  nightShiftWindowKey,
  projectAllowsAmbientWork,
  spawnsChildren,
} from '@bendyline/gezel';
import type { NightShiftQuietReason } from '@bendyline/gezel';
import type { ChatEventBus } from '../chat/events.js';
import type { Store } from '../fs/store.js';
import type { ProviderName } from '../providers/types.js';
import { type TaskManager, stepOwnerGezelId } from './manager.js';
import type { QuotaReserveHold } from './night-quota-gate.js';
import { isOwnerStep } from './step-runtime.js';

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
  /**
   * Night work that is not a task: the index catch-up and what it hands off
   * when it drains (fix planning, observation maintenance). Without it the
   * shift runs only when a task is waiting, so a folder project with nothing
   * scheduled never gets its nightly sweep. Absent = task-driven only.
   */
  ambientWork?: NightShiftAmbientWork;
  /**
   * The computer's power source, as the desktop app reports it. With
   * `nightShift.pauseOnBattery` (default on), the shift stands down on
   * battery and resumes on mains. Absent or unknown never holds it.
   */
  power?: { onBatteryPower(): boolean | null };
}

export interface NightShiftAmbientWork {
  /** Whether any project would get a sweep tonight. Must stay cheap: no index opens. */
  hasEligibleProject(): Promise<boolean>;
  /** Whether the sweep, or the work it handed off, is still running. */
  isRunning(): boolean;
}

/**
 * How long after the window opens a night-shift host that hasn't spawned yet
 * keeps the shift on. Hosts spawn on a 30-minute heartbeat, so a first tick
 * at 22:00 can run before tonight's child exists; past this, a host that
 * still hasn't spawned isn't going to, and must not hold the machine awake.
 */
const HOST_SPAWN_GRACE_MS = 45 * 60_000;

/** Why pending night work is parked, summarized for status surfaces. */
export interface NightShiftQuotaHoldStatus {
  heldTaskCount: number;
  /** One reason per affected provider. */
  reasons: QuotaReserveHold[];
}

/**
 * What this process saw of one night window — for the morning card and the
 * `night-shift.window-settled` history event. In memory only: after a
 * restart mid-window it covers the part of the window since the restart,
 * and a window it never saw open reads as `asleep`.
 */
export interface NightWindowOutcome {
  windowKey: string;
  /** Whether the shift was on at any point in the window. */
  ran: boolean;
  startedAt?: string;
  endedAt?: string;
  /** Why the shift sat off, when it never ran. */
  reason?: NightShiftQuietReason;
}

interface WindowObservation {
  ran: boolean;
  startedAt?: string;
  endedAt?: string;
  offReason?: Exclude<NightShiftQuietReason, 'asleep'>;
}

/** How many recent windows' observations to keep. */
const OBSERVED_WINDOWS = 4;

const TICK_INTERVAL_MS = 30_000;

/**
 * Owns the Night Shift ON/OFF state. Lifecycle mirrors `TaskScheduler` /
 * `IndexEnrichmentManager`: an unref'd interval that recomputes a single
 * boolean each tick. Nothing here is persisted — the active flag is
 * derived from config (window/flags) + live task state, so a restart
 * recomputes from scratch.
 *
 * Decision per tick (after the master `enabled` gate). "Work" is any of:
 * pending night-shift tasks; a night-shift host that hasn't spawned tonight's
 * child yet (early in the window only); ambient work — the index sweep, owed
 * once per window (or manual shift) while any project is eligible, and held
 * for as long as it, or what it handed off, is still running.
 *   - A MANUAL shift ignores the window + latch, staying active until no
 *     work remains, then reverts to scheduled logic.
 *   - SCHEDULED: outside the window → off (latch cleared); window open but
 *     no work → latch off for the rest of THIS window; otherwise on.
 *   - QUOTA-HELD: pending work whose resolved provider is inside the cloud
 *     quota reserve doesn't keep a shift alive. All pending work held →
 *     off WITHOUT latching (parked, not drained) so a mid-window quota
 *     reset re-activates on a later tick; a manual request survives the
 *     hold and resumes by itself. `quotaHoldStatus()` names the parked
 *     state for the UI.
 *   - ON BATTERY (`nightShift.pauseOnBattery`, default on): parked the same
 *     way, for as long as the desktop app reports battery power. Standing
 *     down cancels the sweep (onDeactivated), holds night tasks in the runner
 *     and releases keep-awake; plugging in resumes. `isHeldOnBattery()`.
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
  private readonly ambientWork?: NightShiftAmbientWork;
  private readonly power?: { onBatteryPower(): boolean | null };
  private heldOnBattery = false;

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
  /** Sweep key of the current manual request; one ambient sweep per request. */
  private manualSweepKey: string | null = null;
  /**
   * Window (or manual) key whose ambient sweep has started. Stamped on every
   * activation, whatever triggered it — activation always kicks the sweep —
   * so once the sweep drains the shift can latch off instead of asking for
   * another one.
   */
  private sweptKey: string | null = null;
  /** Window the person stopped by hand; read to tell "stopped" from "drained". */
  private stoppedForWindowKey: string | null = null;
  /** Recent windows, by key, in the order first seen. */
  private readonly observed = new Map<string, WindowObservation>();

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
    this.ambientWork = opts.ambientWork;
    this.power = opts.power;
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
  /** Whether the shift has work but is standing down because the computer is on battery. */
  isHeldOnBattery(): boolean {
    return this.heldOnBattery;
  }

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

  /**
   * Register work to run once when a night window opens, before the tick
   * decides whether there is anything to do — so whatever it queues (the
   * nightly oversight task, re-created or repaired) counts tonight instead
   * of losing to the latch. Awaited; failures are logged, not fatal.
   */
  setOnWindowOpened(fn: (windowKey: string) => Promise<void>): void {
    this.onWindowOpened = fn;
  }
  private onWindowOpened?: (windowKey: string) => Promise<void>;
  private openedNotifiedKey: string | null = null;
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
   * Register the ON → OFF counterpart. Queue-admission consumers need no
   * such signal — they re-read `isActive()` on their next tick — but work
   * the activation callback *started* keeps running on its own until told
   * otherwise, and a long sweep can outlive the window by a wide margin.
   * The index catch-up sweep is the case that motivated this: kicked at
   * activation, it walked project after project for 40 minutes past
   * `endHour`, dispatching night-model one-shots the whole way, because
   * nothing ever told it the night was over.
   *
   * Fires on every ON → OFF edge, including a quota park — a shift that
   * parks has stopped, and re-activation runs `onActivated` again. Awaited,
   * so `stopManual()` returns with the stand-down already signalled;
   * callees must therefore signal rather than drain.
   */
  setOnDeactivated(fn: () => Promise<void>): void {
    this.onDeactivated = fn;
  }
  private onDeactivated?: () => Promise<void>;

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

  /** What this process saw of the window `windowKey` (see {@link NightWindowOutcome}). */
  windowOutcome(windowKey: string): NightWindowOutcome {
    const obs = this.observed.get(windowKey);
    if (!obs) return { windowKey, ran: false, reason: 'asleep' };
    return {
      windowKey,
      ran: obs.ran,
      ...(obs.startedAt ? { startedAt: obs.startedAt } : {}),
      ...(obs.endedAt ? { endedAt: obs.endedAt } : {}),
      ...(obs.ran ? {} : { reason: obs.offReason ?? 'no-work' }),
    };
  }

  /** Manually start a shift now (e.g. user stepping out). */
  async startManual(): Promise<void> {
    this.manualRequested = true;
    this.manualSweepKey = `manual:${this.now().toISOString()}`;
    // Clear any user stop-latch: an explicit start is the user opting back
    // in, so the shift should run even if they'd stopped this window earlier.
    this.latchedOffForWindowKey = null;
    this.stoppedForWindowKey = null;
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
    if (windowKey !== null) {
      this.latchedOffForWindowKey = windowKey;
      this.stoppedForWindowKey = windowKey;
    }
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
    let sweepKey: string | null = null;
    let heldOnBattery = false;

    if (enabled) {
      const windowKey = nightShiftWindowKey(now, window);
      if (windowKey !== null && windowKey !== this.openedNotifiedKey) {
        this.openedNotifiedKey = windowKey;
        await this.onWindowOpened?.(windowKey).catch((err) => {
          log.warn(`[night-shift] window-opened callback failed: ${String(err)}`);
        });
      }
      const todayKey = windowKey ?? localDateKey(now);
      const { pending: pendingTasks, hostAwaitingSpawn } = await this.nightTaskState(todayKey);
      const pending = pendingTasks.length > 0;
      // Hosts only spawn while the window is open, and only early on does a
      // not-yet-spawned host mean "tonight's child is coming".
      const hostsDue =
        hostAwaitingSpawn &&
        windowKey !== null &&
        now.getTime() - nightShiftWindowBounds(now, window).start.getTime() < HOST_SPAWN_GRACE_MS;
      sweepKey = windowKey ?? (this.manualRequested ? this.manualSweepKey : null);
      const ambient = await this.ambientWorkPending(sweepKey, windowKey);
      const work = pending || hostsDue || ambient;
      // Parked, never drained: no latch, so plugging back in resumes the shift
      // on the next tick, and a manual shift survives the unplug.
      const onBattery = ns.pauseOnBattery !== false && this.power?.onBatteryPower() === true;

      // Classify only when the outcome can matter — a shift that could
      // otherwise turn ON this tick. Daytime and latched-off windows skip
      // the gate so no quota probe ever runs outside a shift. Hosts and
      // ambient work spend no provider quota of their own: a host's child is
      // classified once it exists.
      const couldActivate =
        pending &&
        !onBattery &&
        (this.manualRequested || (windowKey !== null && this.latchedOffForWindowKey !== windowKey));
      const { dispatchable, held } = couldActivate
        ? await this.classifyPending(pendingTasks)
        : { dispatchable: pendingTasks, held: [] };
      quotaHeld = held;
      const runnable = !onBattery && (dispatchable.length > 0 || hostsDue || ambient);
      heldOnBattery = onBattery && work;

      if (this.manualRequested) {
        if (!work) {
          // Manual shift drained — revert: fall through to scheduled logic.
          this.manualRequested = false;
          this.manualSweepKey = null;
        } else if (runnable) {
          active = true;
          src = 'manual';
        }
        // else: everything is quota-held, or the computer is on battery. Keep
        // the request — the user asked for this shift, so it resumes by itself
        // when quota frees or the charger goes in; stopManual remains the way
        // out. Not active, so keepAwake releases below.
      }

      if (!active && !this.manualRequested) {
        if (windowKey === null) {
          this.latchedOffForWindowKey = null; // outside window: clear latch
        } else if (this.latchedOffForWindowKey === windowKey) {
          // already drained this window — stay off
        } else if (!work) {
          this.latchedOffForWindowKey = windowKey; // latch off for the rest of the window
        } else if (!runnable) {
          // Quota-held or on battery, NOT drained: off this tick but
          // deliberately no latch — a five_hour bucket can reset mid-window,
          // or the charger goes back in, and the next tick must re-activate
          // (firing onActivated to rehydrate + wake the runner).
        } else {
          active = true;
          src = 'scheduled';
        }
      }
      // Any activation kicks the sweep (onActivated), and a shift that runs
      // on into a new window has already swept tonight. Either way, record
      // it so a drained sweep lets the shift latch off.
      if (active && sweepKey !== null) this.sweptKey = sweepKey;
      if (windowKey !== null) {
        const offReason = active
          ? undefined
          : this.stoppedForWindowKey === windowKey
            ? ('stopped' as const)
            : heldOnBattery
              ? ('on-battery' as const)
              : work && !runnable
                ? ('quota-held' as const)
                : ('no-work' as const);
        this.observeWindow(windowKey, active, offReason, now);
      }
    }

    this.heldOnBattery = heldOnBattery;
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
    const deactivating = !active && this.active;
    this.setActive(active, src);
    if (activating && this.onActivated) {
      await this.onActivated().catch((err) => {
        log.warn(`[night-shift] activation callback failed: ${String(err)}`);
      });
    }
    if (deactivating) {
      for (const obs of this.observed.values()) {
        if (obs.ran && !obs.endedAt) obs.endedAt = now.toISOString();
      }
    }
    if (deactivating && this.onDeactivated) {
      await this.onDeactivated().catch((err) => {
        log.warn(`[night-shift] deactivation callback failed: ${String(err)}`);
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

  private observeWindow(
    windowKey: string,
    active: boolean,
    offReason: WindowObservation['offReason'],
    now: Date,
  ): void {
    let obs = this.observed.get(windowKey);
    if (!obs) {
      obs = { ran: false };
      this.observed.set(windowKey, obs);
      while (this.observed.size > OBSERVED_WINDOWS) {
        const oldest = this.observed.keys().next().value;
        if (oldest === undefined) break;
        this.observed.delete(oldest);
      }
    }
    if (active) {
      obs.ran = true;
      obs.startedAt ??= now.toISOString();
      delete obs.endedAt;
    } else if (!obs.ran && offReason) {
      obs.offReason = offReason;
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
    return (await this.nightTaskState(todayKey)).pending;
  }

  /**
   * One pass over the active tasks: the pending night-shift tasks, and
   * whether any `onceADay` night-shift host still owes tonight's child. Both
   * are confined to projects that allow ambient work.
   */
  private async nightTaskState(
    todayKey: string,
  ): Promise<{ pending: Task[]; hostAwaitingSpawn: boolean }> {
    const tasks = await this.manager.list({ status: 'active' }).catch(() => []);
    const pending: Task[] = [];
    let hostAwaitingSpawn = false;
    const allowsAmbient = new Map<string, boolean>();
    const projectAllows = async (projectId: string): Promise<boolean> => {
      let ok = allowsAmbient.get(projectId);
      if (ok === undefined) {
        const project = await this.store.getProject(projectId).catch(() => null);
        ok = project ? projectAllowsAmbientWork(project) : true;
        allowsAmbient.set(projectId, ok);
      }
      return ok;
    };
    for (const t of tasks) {
      if (isAwaitingNightShiftSpawn(t, todayKey)) {
        if (!hostAwaitingSpawn && (await projectAllows(t.projectId))) hostAwaitingSpawn = true;
        continue;
      }
      if (!isPendingNightShiftTask(t, todayKey)) continue;
      // A step that waits on the owner is not work the shift can do.
      if (isOwnerStep(t.craftbook.steps.find((s) => s.id === t.activeStepId))) continue;
      if (await projectAllows(t.projectId)) pending.push(t);
    }
    return { pending, hostAwaitingSpawn };
  }

  /**
   * Whether ambient (non-task) work keeps or brings the shift on: anything
   * still running, or a sweep not yet started for this window or manual
   * request while some project is eligible. A latched window stays latched
   * unless a manual request reopened it.
   */
  private async ambientWorkPending(
    sweepKey: string | null,
    windowKey: string | null,
  ): Promise<boolean> {
    const work = this.ambientWork;
    if (!work) return false;
    if (work.isRunning()) return true;
    if (sweepKey === null || this.sweptKey === sweepKey) return false;
    if (!this.manualRequested && windowKey !== null && this.latchedOffForWindowKey === windowKey) {
      return false;
    }
    return work.hasEligibleProject().catch(() => false);
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

/**
 * Whether a night-shift spawn host still owes tonight's child. Hosts are
 * never "pending" themselves (they stay active forever), but a `onceADay`
 * host stamps `lastRunDay` when it spawns, so one that hasn't is tonight's
 * work in waiting.
 */
function isAwaitingNightShiftSpawn(task: Task, today: string): boolean {
  if (task.status !== 'active') return false;
  if (!isNightShiftTask(task) || !spawnsChildren(task)) return false;
  if (!task.nightShift?.onceADay) return false;
  return task.nightShift.lastRunDay !== today;
}

/** First hold per provider — one status line per affected provider. */
function dedupeHoldsByProvider(holds: QuotaReserveHold[]): QuotaReserveHold[] {
  const byProvider = new Map<ProviderName, QuotaReserveHold>();
  for (const hold of holds) {
    if (!byProvider.has(hold.provider)) byProvider.set(hold.provider, hold);
  }
  return [...byProvider.values()];
}
