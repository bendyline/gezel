/* Generated from core/suspend-clock.ts by the mobile eval launcher. Test bundles only. */
globalThis.__gezelMobileEvalClock = {};
((exports) => {
  Object.defineProperty(exports, '__esModule', { value: true });
  exports.AwakeBudget =
    exports.DEFAULT_ABORT_AFTER_SUSPENSION_MS =
    exports.DEFAULT_SUSPEND_THRESHOLD_MS =
    exports.DEFAULT_SUSPEND_TICK_MS =
      void 0;
  exports.startSuspendMonitor = startSuspendMonitor;
  exports.stopSuspendMonitor = stopSuspendMonitor;
  exports.isSuspendMonitorRunning = isSuspendMonitorRunning;
  exports.acquireSuspendMonitor = acquireSuspendMonitor;
  exports.awakeNow = awakeNow;
  exports.totalSuspendedMs = totalSuspendedMs;
  exports.suspensionsSince = suspensionsSince;
  exports.longestSuspensionSince = longestSuspensionSince;
  exports.onSuspension = onSuspension;
  exports.resetSuspendClockForTests = resetSuspendClockForTests;
  exports.recordSuspensionForTests = recordSuspensionForTests;
  exports.formatSuspension = formatSuspension;
  exports.createAwakeTimeout = createAwakeTimeout;
  exports.awakeTimeoutSignal = awakeTimeoutSignal;
  exports.DEFAULT_SUSPEND_TICK_MS = 2_000;
  exports.DEFAULT_SUSPEND_THRESHOLD_MS = 10_000;
  const RECENT_LIMIT = 64;
  const RECENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  let monitor = null;
  let monitorLeases = 0;
  let leasedMonitor = null;
  let suspendedTotal = 0;
  let recent = [];
  let reconciling = false;
  const listeners = new Set();
  function reconcile(now) {
    if (!monitor || reconciling) return;
    const gap = now - monitor.lastTickAt;
    monitor.lastTickAt = now;
    if (gap < 0) return;
    if (gap <= monitor.thresholdMs) return;
    const suspendedMs = gap - monitor.tickMs;
    suspendedTotal += suspendedMs;
    const event = { suspendedMs, at: now };
    recent.push(event);
    if (recent.length > RECENT_LIMIT) recent = recent.slice(-RECENT_LIMIT);
    reconciling = true;
    try {
      for (const cb of [...listeners]) {
        try {
          cb(event);
        } catch {}
      }
    } finally {
      reconciling = false;
    }
  }
  function startSuspendMonitor(opts = {}) {
    const tickMs = Math.max(250, opts.tickMs ?? exports.DEFAULT_SUSPEND_TICK_MS);
    const thresholdMs = Math.max(
      tickMs * 2,
      opts.thresholdMs ?? exports.DEFAULT_SUSPEND_THRESHOLD_MS,
    );
    if (monitor) clearInterval(monitor.timer);
    const state = {
      tickMs,
      thresholdMs,
      lastTickAt: Date.now(),
      timer: setInterval(() => reconcile(Date.now()), tickMs),
    };
    state.timer.unref?.();
    monitor = state;
  }
  function stopSuspendMonitor() {
    if (!monitor) return;
    clearInterval(monitor.timer);
    monitor = null;
  }
  function isSuspendMonitorRunning() {
    return monitor !== null;
  }
  function acquireSuspendMonitor() {
    if (!monitor) {
      startSuspendMonitor();
      leasedMonitor = monitor;
    }
    monitorLeases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      monitorLeases = Math.max(0, monitorLeases - 1);
      if (monitorLeases !== 0) return;
      if (leasedMonitor && monitor === leasedMonitor) stopSuspendMonitor();
      leasedMonitor = null;
    };
  }
  function awakeNow() {
    const now = Date.now();
    reconcile(now);
    return now - suspendedTotal;
  }
  function totalSuspendedMs() {
    awakeNow();
    return suspendedTotal;
  }
  function suspensionsSince(wallClockMs) {
    awakeNow();
    const cutoff = Date.now() - RECENT_MAX_AGE_MS;
    recent = recent.filter((e) => e.at >= cutoff);
    return recent.filter((e) => e.at >= wallClockMs);
  }
  function longestSuspensionSince(wallClockMs) {
    let longest = 0;
    for (const e of suspensionsSince(wallClockMs)) {
      if (e.suspendedMs > longest) longest = e.suspendedMs;
    }
    return longest;
  }
  function onSuspension(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  function resetSuspendClockForTests() {
    stopSuspendMonitor();
    monitorLeases = 0;
    leasedMonitor = null;
    suspendedTotal = 0;
    recent = [];
    listeners.clear();
  }
  function recordSuspensionForTests(suspendedMs) {
    suspendedTotal += suspendedMs;
    const event = { suspendedMs, at: Date.now() };
    recent.push(event);
    if (recent.length > RECENT_LIMIT) recent = recent.slice(-RECENT_LIMIT);
    for (const cb of [...listeners]) {
      try {
        cb(event);
      } catch {}
    }
  }
  function formatSuspension(ms) {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    const minutes = Math.round(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
  }
  exports.DEFAULT_ABORT_AFTER_SUSPENSION_MS = 20 * 60 * 1000;
  class AwakeBudget {
    budgetMs;
    startedAt;
    deadline;
    abortAfterSuspensionMs;
    constructor(budgetMs, opts = {}) {
      this.budgetMs = budgetMs;
      this.startedAt = Date.now();
      this.deadline = awakeNow() + budgetMs;
      this.abortAfterSuspensionMs =
        opts.abortAfterSuspensionMs ?? exports.DEFAULT_ABORT_AFTER_SUSPENSION_MS;
    }
    remainingMs() {
      return Math.max(0, this.deadline - awakeNow());
    }
    suspendedMs() {
      let total = 0;
      for (const e of suspensionsSince(this.startedAt)) total += e.suspendedMs;
      return total;
    }
    longestSuspensionMs() {
      return longestSuspensionSince(this.startedAt);
    }
    abandonedToSleep() {
      return this.longestSuspensionMs() >= this.abortAfterSuspensionMs;
    }
    expired() {
      return this.remainingMs() <= 0 || this.abandonedToSleep();
    }
    describeSuspension() {
      const longest = this.longestSuspensionMs();
      if (longest >= this.abortAfterSuspensionMs) {
        return ` — the machine slept for ${formatSuspension(longest)} and the engine connection did not survive; retry`;
      }
      const total = this.suspendedMs();
      if (total <= 0) return '';
      return ` (the machine slept ${formatSuspension(total)} of that, which was not counted against the budget)`;
    }
  }
  exports.AwakeBudget = AwakeBudget;
  function createAwakeTimeout(budgetMs, opts = {}) {
    const budget = new AwakeBudget(budgetMs, opts);
    const pollMs = Math.max(100, Math.min(opts.pollMs ?? 1_000, Math.max(1, budgetMs)));
    const ctrl = new AbortController();
    const timer = setInterval(() => {
      if (!budget.expired()) return;
      clearInterval(timer);
      ctrl.abort(
        opts.reason?.(budget) ??
          new Error(
            `timed out after ${Math.round(budgetMs / 1000)}s${budget.describeSuspension()}`,
          ),
      );
    }, pollMs);
    timer.unref?.();
    const dispose = () => clearInterval(timer);
    ctrl.signal.addEventListener('abort', dispose, { once: true });
    return { signal: ctrl.signal, budget, dispose };
  }
  function awakeTimeoutSignal(budgetMs, opts = {}) {
    return createAwakeTimeout(budgetMs, opts).signal;
  }
})(globalThis.__gezelMobileEvalClock);
