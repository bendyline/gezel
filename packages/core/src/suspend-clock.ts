/**
 * Awake-time clock — a wall clock that stops while the host is suspended.
 *
 * A laptop that sleeps mid-turn freezes every process on the machine: the
 * daemon, the engine subprocess, and the socket between them. Wall clock keeps
 * running, so a `Date.now()`-based deadline is silently consumed by time in
 * which nothing could possibly have made progress. On resume every overdue
 * timer fires at once and the work dies reporting a budget it never actually
 * got — the durable tell is an elapsed-vs-budget mismatch in the log, e.g.
 * `turn#1 END throw afterMs=1002151 [Mac AI] timed out after 180s`, where the
 * 822 s difference IS the nap.
 *
 * Wild-caught on a closed-lid MacBook doing maintenance dark-wake: awake ~90 s
 * every ~16 min, forced back to sleep by `Dark Wake Thermal Emergency` because
 * a resident 27B model reheats the SoC the moment it gets a time slice. Local
 * engine turns ran at roughly a 5% duty cycle, so every long call — one-shots,
 * `consult_*` MCP tools, the enrichment sweep — timed out on the next wake, and
 * the engine idle-eviction timer unloaded resident models on top.
 *
 * The fix is to budget in *awake* time. {@link awakeNow} advances with the wall
 * clock while the machine is running and holds still across a suspension, so a
 * deadline built from it measures time the work could actually have used.
 *
 * Detection is host-agnostic on purpose: a heartbeat that notices its own gap
 * needs no Electron `powerMonitor`, no platform API, and works identically in
 * the embedded service, a spawned daemon, and a machine-wide system service.
 * It also catches suspensions no power API reports — a SIGSTOP'd process, a
 * paused VM, a laptop resumed from hibernation.
 *
 * Until {@link startSuspendMonitor} is called, {@link awakeNow} is exactly
 * `Date.now()`. That is the correct degradation: no monitor means no credit,
 * which is the behavior every caller had before.
 */

/** One observed suspension, reported at the moment the host came back. */
export interface SuspensionEvent {
  /**
   * Wall-clock ms the host spent suspended. The expected heartbeat interval
   * is subtracted, so ordinary scheduling never shows up as a suspension.
   */
  suspendedMs: number;
  /** `Date.now()` when the gap was observed — i.e. on resume, not on sleep. */
  at: number;
}

export const DEFAULT_SUSPEND_TICK_MS = 2_000;

/**
 * Gap above which a heartbeat miss counts as a suspension. Well clear of
 * ordinary event-loop jitter (a long GC pause, a synchronous index write, a
 * loaded machine) so normal stalls are never credited back as sleep. The cost
 * of the floor is that suspensions shorter than it go uncredited, which is
 * harmless — they are shorter than the poll interval of everything that reads
 * this clock.
 */
export const DEFAULT_SUSPEND_THRESHOLD_MS = 10_000;

/** How many recent suspensions to retain for {@link suspensionsSince}. */
const RECENT_LIMIT = 64;
const RECENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface MonitorState {
  tickMs: number;
  thresholdMs: number;
  timer: ReturnType<typeof setInterval>;
  lastTickAt: number;
}

let monitor: MonitorState | null = null;
let suspendedTotal = 0;
let recent: SuspensionEvent[] = [];
let reconciling = false;
const listeners = new Set<(event: SuspensionEvent) => void>();

/**
 * Fold an observed heartbeat gap into the clock. Called from both the
 * heartbeat and {@link awakeNow}: a caller that reads the clock in the first
 * instants after resume, before the interval callback has run, must see the
 * suspension already credited or its deadline expires spuriously in exactly
 * the window this module exists to protect.
 */
function reconcile(now: number): void {
  if (!monitor || reconciling) return;
  const gap = now - monitor.lastTickAt;
  // Re-anchor on EVERY observation, credited or not. The anchor means "the
  // last moment this process was demonstrably running"; leaving it behind on
  // an uncredited tick lets ordinary gaps accumulate until they cross the
  // threshold together and get credited as a suspension that never happened.
  monitor.lastTickAt = now;
  // A negative gap means the wall clock stepped backwards (NTP correction,
  // manual change). Never credit it: a backwards step is not time the work
  // got to use, and crediting it would rewind `awakeNow`.
  if (gap < 0) return;
  if (gap <= monitor.thresholdMs) return;
  const suspendedMs = gap - monitor.tickMs;
  suspendedTotal += suspendedMs;
  const event: SuspensionEvent = { suspendedMs, at: now };
  recent.push(event);
  if (recent.length > RECENT_LIMIT) recent = recent.slice(-RECENT_LIMIT);
  reconciling = true;
  try {
    for (const cb of [...listeners]) {
      try {
        cb(event);
      } catch {
        /* a listener must never be able to break the clock */
      }
    }
  } finally {
    reconciling = false;
  }
}

/**
 * Begin detecting host suspensions. Idempotent — a second call restarts the
 * heartbeat with the new options and keeps the accumulated total, so a
 * reconfigure never rewrites history for deadlines already in flight.
 */
export function startSuspendMonitor(opts: { tickMs?: number; thresholdMs?: number } = {}): void {
  const tickMs = Math.max(250, opts.tickMs ?? DEFAULT_SUSPEND_TICK_MS);
  const thresholdMs = Math.max(tickMs * 2, opts.thresholdMs ?? DEFAULT_SUSPEND_THRESHOLD_MS);
  if (monitor) clearInterval(monitor.timer);
  const state: MonitorState = {
    tickMs,
    thresholdMs,
    lastTickAt: Date.now(),
    timer: setInterval(() => reconcile(Date.now()), tickMs),
  };
  state.timer.unref?.();
  monitor = state;
}

/** Stop detecting suspensions. The accumulated total is retained. */
export function stopSuspendMonitor(): void {
  if (!monitor) return;
  clearInterval(monitor.timer);
  monitor = null;
}

export function isSuspendMonitorRunning(): boolean {
  return monitor !== null;
}

/**
 * Wall-clock ms minus every suspension observed so far. Strictly increasing:
 * a suspension is credited as `gap - tickMs`, so the clock still advances by
 * one heartbeat across a nap rather than standing perfectly still.
 */
export function awakeNow(): number {
  const now = Date.now();
  reconcile(now);
  return now - suspendedTotal;
}

/** Total suspension credited since process start. */
export function totalSuspendedMs(): number {
  awakeNow();
  return suspendedTotal;
}

/** Suspensions observed since a `Date.now()` marker, oldest first. */
export function suspensionsSince(wallClockMs: number): SuspensionEvent[] {
  awakeNow();
  const cutoff = Date.now() - RECENT_MAX_AGE_MS;
  recent = recent.filter((e) => e.at >= cutoff);
  return recent.filter((e) => e.at >= wallClockMs);
}

/**
 * The single longest suspension observed since a `Date.now()` marker. Callers
 * use this to distinguish "the machine napped a few times, carry on" from
 * "the machine was asleep for an hour, the far end of this socket is not
 * coming back" — a distinction total suspended time cannot make.
 */
export function longestSuspensionSince(wallClockMs: number): number {
  let longest = 0;
  for (const e of suspensionsSince(wallClockMs)) {
    if (e.suspendedMs > longest) longest = e.suspendedMs;
  }
  return longest;
}

/** Subscribe to resume events. Returns an unsubscribe function. */
export function onSuspension(cb: (event: SuspensionEvent) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test seam: forget all accumulated state and stop the heartbeat. */
export function resetSuspendClockForTests(): void {
  stopSuspendMonitor();
  suspendedTotal = 0;
  recent = [];
  listeners.clear();
}

/** Test seam: credit a suspension without waiting for real host sleep. */
export function recordSuspensionForTests(suspendedMs: number): void {
  suspendedTotal += suspendedMs;
  const event: SuspensionEvent = { suspendedMs, at: Date.now() };
  recent.push(event);
  if (recent.length > RECENT_LIMIT) recent = recent.slice(-RECENT_LIMIT);
  for (const cb of [...listeners]) {
    try {
      cb(event);
    } catch {
      /* see reconcile */
    }
  }
}

/** Human-readable duration for log lines and user-facing timeout messages. */
export function formatSuspension(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

/**
 * Default cap on a *single* suspension a long-running operation will sit
 * through. Repeated short naps — the dark-wake maintenance pattern, ~16 min
 * apiece — are survivable: loopback sockets and the engine subprocess come
 * back with the machine, so crediting them lets a turn finish instead of dying
 * for reasons the user cannot see. One nap longer than this means the machine
 * was genuinely put away, and holding a stream open on the hope it resumes
 * costs more than an honest, promptly-reported failure.
 */
export const DEFAULT_ABORT_AFTER_SUSPENSION_MS = 20 * 60 * 1000;

export interface AwakeBudgetOptions {
  /**
   * Longest single suspension to sit through before giving up. See
   * {@link DEFAULT_ABORT_AFTER_SUSPENSION_MS}. `Infinity` never gives up.
   */
  abortAfterSuspensionMs?: number;
}

/**
 * A deadline measured in awake time.
 *
 * Replaces the `const deadline = Date.now() + timeoutMs` / `Date.now() >=
 * deadline` pair. The budget is only consumed while the host is running, so a
 * nap postpones the deadline rather than eating it — but a nap long enough to
 * mean the machine was put away still ends the operation, and
 * {@link describeSuspension} gives the caller honest wording for why.
 */
export class AwakeBudget {
  readonly budgetMs: number;
  /** `Date.now()` at construction, used to scope suspension queries. */
  readonly startedAt: number;
  private readonly deadline: number;
  private readonly abortAfterSuspensionMs: number;

  constructor(budgetMs: number, opts: AwakeBudgetOptions = {}) {
    this.budgetMs = budgetMs;
    this.startedAt = Date.now();
    this.deadline = awakeNow() + budgetMs;
    this.abortAfterSuspensionMs = opts.abortAfterSuspensionMs ?? DEFAULT_ABORT_AFTER_SUSPENSION_MS;
  }

  /** Awake ms left, floored at 0. */
  remainingMs(): number {
    return Math.max(0, this.deadline - awakeNow());
  }

  /** Total suspension the host took since this budget started. */
  suspendedMs(): number {
    let total = 0;
    for (const e of suspensionsSince(this.startedAt)) total += e.suspendedMs;
    return total;
  }

  /** The longest single suspension since this budget started. */
  longestSuspensionMs(): number {
    return longestSuspensionSince(this.startedAt);
  }

  /**
   * True when a single suspension crossed the give-up threshold. Checked
   * separately from {@link expired} so callers can say which happened.
   */
  abandonedToSleep(): boolean {
    return this.longestSuspensionMs() >= this.abortAfterSuspensionMs;
  }

  /** True when the operation should stop, for either reason. */
  expired(): boolean {
    return this.remainingMs() <= 0 || this.abandonedToSleep();
  }

  /**
   * Message fragment naming host sleep as a factor, or `''` when the host
   * stayed awake and the plain timeout wording is the whole truth. Appended
   * to timeout errors so "timed out after 180s" never again describes 1002
   * seconds of which 822 were sleep.
   */
  describeSuspension(): string {
    const longest = this.longestSuspensionMs();
    if (longest >= this.abortAfterSuspensionMs) {
      return ` — the machine slept for ${formatSuspension(longest)} and the engine connection did not survive; retry`;
    }
    const total = this.suspendedMs();
    if (total <= 0) return '';
    return ` (the machine slept ${formatSuspension(total)} of that, which was not counted against the budget)`;
  }
}

export type AwakeTimeoutOptions = AwakeBudgetOptions & {
  pollMs?: number;
  reason?: (budget: AwakeBudget) => unknown;
};

/**
 * An `AbortSignal` that fires when an awake-time budget runs out — the
 * sleep-aware replacement for `AbortSignal.timeout(ms)` — plus the `dispose`
 * that stops polling once the work it guards has finished.
 *
 * Implemented as a poll rather than a single armed timer because a timer armed
 * before a suspension fires the instant the host resumes, which is the bug
 * being fixed. Polling re-reads {@link awakeNow} each tick, so a nap defers the
 * abort; drift is bounded by `pollMs`, never by the sleep duration.
 *
 * `dispose` matters more here than under `AbortSignal.timeout`: a poll that
 * outlives its call keeps ticking for the whole budget — up to 35 minutes for
 * a consultation tool — and a busy session would accumulate hundreds of them.
 * On a laptop those wakeups are exactly what stops a CPU settling into a low
 * power state, which would be an unfortunate way to fix a sleep bug. Callers
 * that finish early must dispose in a `finally`; the timer still self-clears
 * at expiry for callers that cannot.
 */
export function createAwakeTimeout(
  budgetMs: number,
  opts: AwakeTimeoutOptions = {},
): { signal: AbortSignal; budget: AwakeBudget; dispose: () => void } {
  const budget = new AwakeBudget(budgetMs, opts);
  const pollMs = Math.max(100, Math.min(opts.pollMs ?? 1_000, Math.max(1, budgetMs)));
  const ctrl = new AbortController();
  const timer = setInterval(() => {
    if (!budget.expired()) return;
    clearInterval(timer);
    ctrl.abort(
      opts.reason?.(budget) ??
        new Error(`timed out after ${Math.round(budgetMs / 1000)}s${budget.describeSuspension()}`),
    );
  }, pollMs);
  timer.unref?.();
  const dispose = () => clearInterval(timer);
  ctrl.signal.addEventListener('abort', dispose, { once: true });
  return { signal: ctrl.signal, budget, dispose };
}

/**
 * {@link createAwakeTimeout} without the handle, for call sites whose guarded
 * work runs for essentially the whole budget anyway.
 */
export function awakeTimeoutSignal(budgetMs: number, opts: AwakeTimeoutOptions = {}): AbortSignal {
  return createAwakeTimeout(budgetMs, opts).signal;
}
