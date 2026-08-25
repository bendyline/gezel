import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AwakeBudget,
  awakeNow,
  awakeTimeoutSignal,
  createAwakeTimeout,
  formatSuspension,
  isSuspendMonitorRunning,
  longestSuspensionSince,
  onSuspension,
  recordSuspensionForTests,
  resetSuspendClockForTests,
  startSuspendMonitor,
  stopSuspendMonitor,
  totalSuspendedMs,
} from './suspend-clock.js';

/**
 * Jump the wall clock without letting any timer observe the intervening
 * moments — what a host suspension looks like from inside the process.
 */
function sleepHost(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe('suspend clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T10:00:00Z'));
    resetSuspendClockForTests();
  });

  afterEach(() => {
    resetSuspendClockForTests();
    vi.useRealTimers();
  });

  it('is exactly the wall clock until the monitor starts', () => {
    expect(isSuspendMonitorRunning()).toBe(false);
    expect(awakeNow()).toBe(Date.now());
    sleepHost(900_000);
    expect(awakeNow()).toBe(Date.now());
    expect(totalSuspendedMs()).toBe(0);
  });

  it('credits a host suspension so awake time barely advances across it', () => {
    startSuspendMonitor({ tickMs: 2_000, thresholdMs: 10_000 });
    const before = awakeNow();
    sleepHost(900_000);
    // One heartbeat of credit is deliberately withheld, so the clock still
    // moves forward rather than standing perfectly still.
    expect(awakeNow() - before).toBe(2_000);
    expect(totalSuspendedMs()).toBe(898_000);
  });

  it('does not credit ordinary event-loop jitter below the threshold', () => {
    startSuspendMonitor({ tickMs: 2_000, thresholdMs: 10_000 });
    const before = awakeNow();
    sleepHost(8_000);
    expect(awakeNow() - before).toBe(8_000);
    expect(totalSuspendedMs()).toBe(0);
  });

  it('re-anchors without crediting when the wall clock steps backwards', () => {
    startSuspendMonitor({ tickMs: 2_000, thresholdMs: 10_000 });
    vi.setSystemTime(Date.now() - 60_000);
    awakeNow();
    expect(totalSuspendedMs()).toBe(0);
    // The re-anchor must not leave a phantom gap for the next read to credit.
    sleepHost(5_000);
    expect(totalSuspendedMs()).toBe(0);
  });

  it('notifies listeners on resume with the suspended duration', () => {
    startSuspendMonitor({ tickMs: 2_000, thresholdMs: 10_000 });
    const seen: number[] = [];
    const off = onSuspension((e) => seen.push(e.suspendedMs));
    sleepHost(600_000);
    awakeNow();
    expect(seen).toEqual([598_000]);
    off();
    sleepHost(600_000);
    awakeNow();
    expect(seen).toHaveLength(1);
  });

  it('reports the longest single suspension, not just the total', () => {
    startSuspendMonitor({ tickMs: 2_000, thresholdMs: 10_000 });
    const from = Date.now();
    recordSuspensionForTests(300_000);
    recordSuspensionForTests(900_000);
    recordSuspensionForTests(120_000);
    expect(longestSuspensionSince(from)).toBe(900_000);
    expect(totalSuspendedMs()).toBe(1_320_000);
  });

  it('stops crediting once the monitor is stopped but keeps the total', () => {
    startSuspendMonitor({ tickMs: 2_000, thresholdMs: 10_000 });
    sleepHost(600_000);
    awakeNow();
    const total = totalSuspendedMs();
    stopSuspendMonitor();
    sleepHost(600_000);
    expect(totalSuspendedMs()).toBe(total);
  });
});

describe('AwakeBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T10:00:00Z'));
    resetSuspendClockForTests();
    startSuspendMonitor({ tickMs: 2_000, thresholdMs: 10_000 });
  });

  afterEach(() => {
    resetSuspendClockForTests();
    vi.useRealTimers();
  });

  it('does not spend budget while the host is suspended', () => {
    const budget = new AwakeBudget(180_000);
    sleepHost(900_000);
    expect(budget.expired()).toBe(false);
    expect(budget.remainingMs()).toBe(178_000);
    expect(budget.suspendedMs()).toBe(898_000);
  });

  it('still expires on awake time actually consumed', () => {
    const budget = new AwakeBudget(180_000);
    // Two naps plus real work either side, as a dark-wake cycle looks.
    sleepHost(900_000);
    awakeNow();
    vi.advanceTimersByTime(100_000);
    sleepHost(900_000);
    awakeNow();
    expect(budget.expired()).toBe(false);
    vi.advanceTimersByTime(100_000);
    expect(budget.expired()).toBe(true);
  });

  it('gives up when a single suspension says the machine was put away', () => {
    const budget = new AwakeBudget(180_000, { abortAfterSuspensionMs: 20 * 60_000 });
    sleepHost(90 * 60_000);
    expect(budget.abandonedToSleep()).toBe(true);
    expect(budget.expired()).toBe(true);
    expect(budget.describeSuspension()).toContain('the machine slept for 1h30m');
    expect(budget.describeSuspension()).toContain('retry');
  });

  it('sits through repeated short naps that a single-nap cap would survive', () => {
    const budget = new AwakeBudget(600_000, { abortAfterSuspensionMs: 20 * 60_000 });
    for (let i = 0; i < 6; i++) {
      sleepHost(16 * 60_000);
      awakeNow();
      vi.advanceTimersByTime(60_000);
    }
    expect(budget.abandonedToSleep()).toBe(false);
    expect(budget.expired()).toBe(false);
    expect(budget.describeSuspension()).toContain('not counted against the budget');
  });

  it('says nothing about sleep when the host stayed awake', () => {
    const budget = new AwakeBudget(180_000);
    vi.advanceTimersByTime(60_000);
    expect(budget.describeSuspension()).toBe('');
  });
});

describe('awakeTimeoutSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T10:00:00Z'));
    resetSuspendClockForTests();
    startSuspendMonitor({ tickMs: 2_000, thresholdMs: 10_000 });
  });

  afterEach(() => {
    resetSuspendClockForTests();
    vi.useRealTimers();
  });

  it('does not fire on the wake-up burst after a nap', () => {
    const signal = awakeTimeoutSignal(180_000, { pollMs: 1_000 });
    sleepHost(900_000);
    vi.advanceTimersByTime(2_000);
    expect(signal.aborted).toBe(false);
  });

  it('fires once the awake budget is genuinely spent', () => {
    const signal = awakeTimeoutSignal(180_000, { pollMs: 1_000 });
    sleepHost(900_000);
    vi.advanceTimersByTime(181_000);
    expect(signal.aborted).toBe(true);
    expect(String((signal.reason as Error).message)).toContain('timed out after 180s');
  });

  it('stops polling once disposed, so a short call leaves no timer behind', () => {
    // Baseline excludes the suspend-monitor heartbeat this suite starts.
    const baseline = vi.getTimerCount();
    const deadline = createAwakeTimeout(180_000, { pollMs: 1_000 });
    expect(vi.getTimerCount()).toBe(baseline + 1);
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(baseline);
    // A disposed deadline must also stay un-fired — disposal means "the work
    // finished", not "give up on it".
    vi.advanceTimersByTime(600_000);
    expect(deadline.signal.aborted).toBe(false);
  });

  it('fires promptly when one suspension crosses the give-up threshold', () => {
    const signal = awakeTimeoutSignal(180_000, {
      pollMs: 1_000,
      abortAfterSuspensionMs: 10 * 60_000,
    });
    sleepHost(45 * 60_000);
    vi.advanceTimersByTime(1_000);
    expect(signal.aborted).toBe(true);
    expect(String((signal.reason as Error).message)).toContain('the machine slept');
  });
});

describe('formatSuspension', () => {
  it('reads as a duration a person would say out loud', () => {
    expect(formatSuspension(45_000)).toBe('45s');
    expect(formatSuspension(16 * 60_000)).toBe('16m');
    expect(formatSuspension(60 * 60_000)).toBe('1h');
    expect(formatSuspension(88 * 60_000)).toBe('1h28m');
  });
});
