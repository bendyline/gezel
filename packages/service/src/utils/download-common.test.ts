import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_RETRIES,
  DownloadRetryBudget,
  MAX_TOTAL_ATTEMPTS,
  PROGRESS_REFUND_BYTES,
} from './download-common.js';

const MB = 1024 * 1024;

describe('DownloadRetryBudget', () => {
  it('gives up after the configured run of no-progress failures', () => {
    const budget = new DownloadRetryBudget(3);
    for (let i = 0; i < 3; i++) {
      expect(budget.canAttempt()).toBe(true);
      budget.beginAttempt();
      budget.recordFailure(0);
    }
    expect(budget.canAttempt()).toBe(false);
    expect(budget.attemptsMade).toBe(3);
  });

  it('refunds the budget when an attempt actually moved bytes', () => {
    // The first-run failure this exists to fix: a multi-GB model over a link
    // that drops every few minutes used to burn all five attempts inside the
    // first ten minutes and quit, despite every attempt writing hundreds of
    // megabytes to disk.
    const budget = new DownloadRetryBudget(DEFAULT_MAX_RETRIES);
    let bytes = 0;
    for (let i = 0; i < 20; i++) {
      expect(budget.canAttempt()).toBe(true);
      budget.beginAttempt();
      bytes += 200 * MB;
      budget.recordFailure(bytes);
    }
    expect(budget.canAttempt()).toBe(true);
  });

  it('still gives up when the progress is too small to count', () => {
    const budget = new DownloadRetryBudget(3);
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      budget.beginAttempt();
      bytes += Math.floor(PROGRESS_REFUND_BYTES / 4);
      budget.recordFailure(bytes);
    }
    expect(budget.canAttempt()).toBe(false);
  });

  it('needs a fresh run of no-progress failures after a refund', () => {
    const budget = new DownloadRetryBudget(2);
    budget.beginAttempt();
    budget.recordFailure(0); // 1 consecutive
    budget.beginAttempt();
    budget.recordFailure(500 * MB); // progress → refund
    expect(budget.canAttempt()).toBe(true);
    budget.beginAttempt();
    budget.recordFailure(500 * MB); // no further progress → 1 consecutive
    expect(budget.canAttempt()).toBe(true);
    budget.beginAttempt();
    budget.recordFailure(500 * MB); // 2 consecutive
    expect(budget.canAttempt()).toBe(false);
  });

  it('measures progress against the bytes already on disk at construction', () => {
    // A resumed download starts with a populated `.partial`; re-reporting that
    // same offset is not progress.
    const budget = new DownloadRetryBudget(2, 900 * MB);
    budget.beginAttempt();
    budget.recordFailure(900 * MB);
    budget.beginAttempt();
    budget.recordFailure(900 * MB);
    expect(budget.canAttempt()).toBe(false);
  });

  it('caps total attempts even while progress keeps refunding', () => {
    const budget = new DownloadRetryBudget(5, 0, 8);
    let bytes = 0;
    while (budget.canAttempt()) {
      budget.beginAttempt();
      bytes += 100 * MB;
      budget.recordFailure(bytes);
    }
    expect(budget.attemptsMade).toBe(8);
  });

  it('honors maxRetries: 1 as "no retry", progress or not', () => {
    const budget = new DownloadRetryBudget(1);
    budget.beginAttempt();
    budget.recordFailure(5_000 * MB);
    expect(budget.canAttempt()).toBe(false);
  });

  it('restarts the backoff schedule after a refund', () => {
    const budget = new DownloadRetryBudget(5);
    budget.beginAttempt();
    budget.recordFailure(0);
    budget.beginAttempt();
    budget.recordFailure(0);
    budget.beginAttempt();
    budget.recordFailure(0);
    const deepDelay = budget.nextDelayMs();
    budget.beginAttempt();
    budget.recordFailure(500 * MB);
    // The link is clearly alive again — don't keep serving the long waits.
    expect(budget.nextDelayMs()).toBeLessThan(deepDelay);
    expect(budget.nextAttemptLabel).toBe(1);
  });

  it('exposes a sane default ceiling', () => {
    expect(MAX_TOTAL_ATTEMPTS).toBeGreaterThan(DEFAULT_MAX_RETRIES);
  });
});
